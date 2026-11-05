"""Conversations follow positions, inside a repertoire's access boundary."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import chess
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, update

from prepforge_chess.api.deps import current_owner, get_repository, member_name
from prepforge_chess.api.routers.workspace import _repertoire_access
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository

router = APIRouter(prefix="/api/build/discussions", tags=["discussions"])


def position_key(fen: str) -> str:
    try:
        board = chess.Board(fen)
        if not board.is_valid():
            raise ValueError("invalid position")
        return " ".join(board.fen(en_passant="legal").split()[:4])
    except ValueError as exc:
        raise HTTPException(422, detail="Choose a valid board position.") from exc


def _positions(repo, rid):
    repertoire = repo.load_repertoire(rid)
    return {position_key(node.fen): node.id for node in repo._walk_nodes(repertoire.root_node)}


def _thread(conn, rid, thread_id):
    row = conn.execute(select(t.position_threads).where(
        t.position_threads.c.repertoire_id == rid, t.position_threads.c.id == thread_id)).mappings().first()
    if not row:
        raise HTTPException(404, detail="Discussion not found.")
    return row


@router.get("")
def discussions(repertoire_id: str, owner: str = Depends(current_owner),
                repo: WorkspaceRepository = Depends(get_repository)):
    meta = _repertoire_access(repo, repertoire_id, owner)
    positions = _positions(repo, repertoire_id)
    with repo.engine.connect() as conn:
        threads = conn.execute(select(t.position_threads).where(
            t.position_threads.c.repertoire_id == repertoire_id).order_by(t.position_threads.c.created_at)).mappings().all()
        messages = conn.execute(select(t.position_messages, t.users.c.display_name, t.users.c.email).select_from(
            t.position_messages.join(t.position_threads, t.position_threads.c.id == t.position_messages.c.thread_id)
            .outerjoin(t.users, t.users.c.id == t.position_messages.c.author_id)
        ).where(t.position_threads.c.repertoire_id == repertoire_id).order_by(
            t.position_messages.c.created_at, t.position_messages.c.id)).mappings().all()
    by_thread = {}
    for message in messages:
        by_thread.setdefault(message["thread_id"], []).append({
            "id": message["id"], "author": member_name(message["display_name"], message["email"]),
            "body": message["body"], "created_at": message["created_at"].isoformat(),
        })
    return {"threads": [{
        "id": row["id"], "fen": row["fen"], "position_key": row["position_key"],
        "node_id": positions.get(row["position_key"]), "resolved": bool(row["resolved"]),
        "can_resolve": meta["role"] == "owner" or row["created_by"] == owner,
        "can_reanchor": meta["role"] in ("owner", "edit"),
        "messages": by_thread.get(row["id"], []),
    } for row in threads]}


class MessageBody(BaseModel):
    repertoire_id: str
    fen: str | None = Field(default=None, max_length=160)
    thread_id: str | None = None
    body: str = Field(min_length=1, max_length=5000)

    @field_validator("body")
    @classmethod
    def not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Write a message.")
        return value


@router.post("")
def add_message(body: MessageBody, owner: str = Depends(current_owner),
                repo: WorkspaceRepository = Depends(get_repository)):
    _repertoire_access(repo, body.repertoire_id, owner)
    repo.op_actor, repo.op_kind = owner, "discussion"
    with repo.repertoire_edit(body.repertoire_id):
        conn = repo._edit_connection
        now = datetime.now(timezone.utc)
        if body.thread_id:
            thread_id = _thread(conn, body.repertoire_id, body.thread_id)["id"]
        else:
            key = position_key(body.fen or "")
            if key not in _positions(repo, body.repertoire_id):
                raise HTTPException(409, detail="This position left the tree. Refresh before starting a discussion.")
            thread_id = conn.scalar(select(t.position_threads.c.id).where(
                t.position_threads.c.repertoire_id == body.repertoire_id, t.position_threads.c.position_key == key))
            if not thread_id:
                thread_id = str(uuid.uuid4())
                conn.execute(t.position_threads.insert().values(
                    id=thread_id, repertoire_id=body.repertoire_id, fen=body.fen,
                    position_key=key, created_by=owner, resolved=0, created_at=now))
        conn.execute(t.position_messages.insert().values(
            id=str(uuid.uuid4()), thread_id=thread_id, author_id=owner, body=body.body, created_at=now))
        revision = repo._bump_revision(conn, body.repertoire_id, discussion_id=thread_id)
    return {"thread_id": thread_id, "revision": revision}


class ThreadBody(BaseModel):
    repertoire_id: str
    thread_id: str
    resolved: bool | None = None
    fen: str | None = Field(default=None, max_length=160)


@router.post("/update")
def update_thread(body: ThreadBody, owner: str = Depends(current_owner),
                  repo: WorkspaceRepository = Depends(get_repository)):
    meta = _repertoire_access(repo, body.repertoire_id, owner)
    repo.op_actor, repo.op_kind = owner, "discussion_update"
    with repo.repertoire_edit(body.repertoire_id):
        conn = repo._edit_connection
        row = _thread(conn, body.repertoire_id, body.thread_id)
        values = {}
        if body.resolved is not None:
            if meta["role"] != "owner" and row["created_by"] != owner:
                raise HTTPException(403, detail="Only the author or repertoire owner can resolve this discussion.")
            values["resolved"] = int(body.resolved)
        if body.fen is not None:
            _repertoire_access(repo, body.repertoire_id, owner, "edit")
            key = position_key(body.fen)
            if key not in _positions(repo, body.repertoire_id):
                raise HTTPException(409, detail="Choose a position in this repertoire.")
            existing = conn.scalar(select(t.position_threads.c.id).where(
                t.position_threads.c.repertoire_id == body.repertoire_id, t.position_threads.c.position_key == key))
            if existing and existing != body.thread_id:
                raise HTTPException(409, detail="That position already has a discussion. Choose another move.")
            values.update(fen=body.fen, position_key=key)
        if not values:
            raise HTTPException(422, detail="Choose a change.")
        conn.execute(update(t.position_threads).where(t.position_threads.c.id == body.thread_id).values(**values))
        revision = repo._bump_revision(conn, body.repertoire_id, discussion_id=body.thread_id)
    return {"thread_id": body.thread_id, "revision": revision}
