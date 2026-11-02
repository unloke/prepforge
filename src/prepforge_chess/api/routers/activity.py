"""Recent repertoire activity and conflict-checked inverse edits."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update

from prepforge_chess.api.deps import current_owner, get_repository
from prepforge_chess.api.routers.workspace import _repertoire_access, _payload
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository

router = APIRouter(prefix="/api/build", tags=["activity"])


@router.get("/activity")
def activity(repertoire_id: str, owner: str = Depends(current_owner),
             repo: WorkspaceRepository = Depends(get_repository)):
    meta = _repertoire_access(repo, repertoire_id, owner)
    seen = repo.get_user_setting(owner, f"activity.seen.{repertoire_id}", 0)
    with repo.engine.connect() as conn:
        rows = conn.execute(select(t.repertoire_ops, t.users.c.display_name).select_from(
            t.repertoire_ops.outerjoin(t.users, t.users.c.id == t.repertoire_ops.c.actor_user_id)
        ).where(t.repertoire_ops.c.repertoire_id == repertoire_id).order_by(
            t.repertoire_ops.c.revision.desc()
        )).mappings().all()
    reversed_revisions = {json.loads(row["op_json"]).get("reverted_revision") for row in rows}
    entries, unread_nodes = [], set()
    for row in rows:
        op = json.loads(row["op_json"])
        unread = row["revision"] > seen and row["actor_user_id"] not in (owner, None)
        if unread:
            unread_nodes.update(op.get("nodes", []))
        delta = op.get("delta", {})
        entries.append({
            "revision": row["revision"], "kind": row["kind"],
            "actor": row["display_name"] or ("Former member" if row["actor_user_id"] else "PrepForge"),
            "created_at": row["created_at"].isoformat(), "unread": unread,
            "nodes": op.get("nodes", []), "removed": op.get("removed", []),
            "added": sum(change["before"] is None for change in delta.values()),
            "edited": sum(change["before"] is not None and change["after"] is not None for change in delta.values()),
            "deleted": len(op.get("removed", [])),
            "can_revert": meta["role"] == "owner" and bool(delta or op.get("metadata"))
                          and row["revision"] not in reversed_revisions,
            "reverted": row["revision"] in reversed_revisions,
            "discussion_id": op.get("discussion_id"),
        })
    return {"revision": meta["revision"], "seen": seen, "entries": entries,
            "unread_nodes": sorted(unread_nodes),
            "truncated": bool(rows and rows[-1]["revision"] > 1)}


class SeenBody(BaseModel):
    repertoire_id: str
    revision: int = Field(ge=0)


@router.post("/activity/seen")
def activity_seen(body: SeenBody, owner: str = Depends(current_owner),
                  repo: WorkspaceRepository = Depends(get_repository)):
    meta = _repertoire_access(repo, body.repertoire_id, owner)
    revision = min(body.revision, meta["revision"])
    seen = repo.mutate_user_setting(owner, f"activity.seen.{body.repertoire_id}",
                                   lambda value: max(value or 0, revision))
    return {"seen": seen}


class RevertBody(SeenBody):
    pass


def _conflict(message):
    raise HTTPException(409, detail=message)


@router.post("/activity/revert")
def activity_revert(body: RevertBody, owner: str = Depends(current_owner),
                    repo: WorkspaceRepository = Depends(get_repository)):
    meta = _repertoire_access(repo, body.repertoire_id, owner, "owner")
    rid = body.repertoire_id
    repo.op_actor, repo.op_kind = owner, "revert"
    with repo.repertoire_edit(rid):
        conn = repo._edit_connection
        encoded = conn.scalar(select(t.repertoire_ops.c.op_json).where(
            t.repertoire_ops.c.repertoire_id == rid, t.repertoire_ops.c.revision == body.revision))
        if encoded is None:
            raise HTTPException(404, detail="This edit is no longer in recent activity.")
        op = json.loads(encoded)
        delta, metadata = op.get("delta", {}), op.get("metadata", {})
        if not delta and not metadata:
            _conflict("This event has no reversible tree edit.")
        current = repo._node_rows(conn, rid, delta)
        for node_id, change in delta.items():
            after = change["after"]
            row = current.get(node_id)
            if after is None:
                if row is not None:
                    _conflict("A deleted move has been restored or replaced. Refresh activity.")
            elif row is None or any(row[key] != value for key, value in after.items()):
                _conflict("These moves were edited again. Review the newer edit first.")
        rep = conn.execute(select(t.repertoires).where(t.repertoires.c.id == rid)).mappings().one()
        for key, change in metadata.items():
            if rep[key] != change["after"]:
                _conflict("The repertoire was renamed or changed again. Review the newer edit first.")
        removing = {node_id for node_id, change in delta.items() if change["before"] is None}
        restoring = {node_id: change["before"] for node_id, change in delta.items()
                     if change["after"] is None}
        if removing and conn.scalar(select(t.opening_nodes.c.id).where(
            t.opening_nodes.c.parent_id.in_(removing), ~t.opening_nodes.c.id.in_(removing)).limit(1)):
            _conflict("New moves continue this line. Remove those continuations first.")
        for row in restoring.values():
            parent = row["parent_id"]
            if parent not in restoring and not conn.scalar(select(t.opening_nodes.c.id).where(
                t.opening_nodes.c.id == parent, t.opening_nodes.c.repertoire_id == rid)):
                _conflict("The parent line is missing. Restore its deletion first.")
        # Inserts follow parents; partial updates only undo the fields this op wrote.
        pending = dict(restoring)
        while pending:
            ready = [node_id for node_id, row in pending.items() if row["parent_id"] not in pending]
            if not ready:
                _conflict("This edit cannot restore a valid move tree.")
            for node_id in ready:
                conn.execute(t.opening_nodes.insert().values(**pending.pop(node_id)))
        for node_id, change in delta.items():
            if change["before"] is not None and change["after"] is not None:
                conn.execute(update(t.opening_nodes).where(t.opening_nodes.c.id == node_id).values(**change["before"]))
        if removing:
            week_ago = datetime.now(timezone.utc) - timedelta(days=7)
            reviewed = conn.execute(select(t.training_progress.c.owner_user_id, t.training_progress.c.last_reviewed_at).where(
                t.training_progress.c.node_id.in_(removing), t.training_progress.c.last_reviewed_at >= week_ago)).all()
            conn.execute(update(t.training_sessions).where(t.training_sessions.c.current_node_id.in_(removing)).values(current_node_id=None))
            conn.execute(delete(t.opening_nodes).where(t.opening_nodes.c.id.in_(removing)))
            repo._archive_reviews(conn, reviewed, week_ago)
        old_meta = {key: rep[key] for key in metadata}
        if metadata:
            conn.execute(update(t.repertoires).where(t.repertoires.c.id == rid).values(
                **{key: change["before"] for key, change in metadata.items()}))
        repo._bump_revision(conn, rid, nodes=set(delta) - removing, removed=removing,
                            before=current, meta=bool(metadata), metadata_before=old_meta,
                            reverted_revision=body.revision)
    return _payload(repo, meta)
