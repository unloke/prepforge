"""Scout's read of the caller's own repertoire trees.

Scout only asks "does my tree play this move here?", so it needs each node's
place in the tree and nothing else: no SAN/FEN replay, no engine evaluations, no
training progress or health. One request covers every active repertoire, where
Scout's start-up used to load each one through ``/api/build/load``.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import select

from prepforge_chess.api.deps import current_owner, get_repository
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.ports import UnitOfWork

router = APIRouter(prefix="/api/scout", tags=["scout"])


def _slim_nodes(rows: list[Any]) -> list[dict[str, Any]]:
    """The nodes reachable from the root, root first, each with its depth."""
    children: dict[str | None, list[Any]] = {}
    for row in rows:
        children.setdefault(row.parent_id, []).append(row)
    out: list[dict[str, Any]] = []
    stack = [(root, 0) for root in reversed(children.get(None, [])[:1])]
    while stack:
        row, depth = stack.pop()
        out.append({
            "id": row.id,
            "parent_id": row.parent_id,
            "uci": row.uci,
            "depth": depth,
            "is_enabled": bool(row.is_enabled),
            "is_mainline": bool(row.is_mainline),
        })
        stack.extend((child, depth + 1) for child in reversed(children.get(row.id, [])))
    return out


@router.get("/trees")
def scout_trees(
    owner: str = Depends(current_owner),
    repo: UnitOfWork = Depends(get_repository),
) -> dict[str, Any]:
    """Every active repertoire the caller owns, with its tree as
    ``{id, parent_id, uci, depth, is_enabled, is_mainline}`` nodes."""
    reps, nodes = t.repertoires, t.opening_nodes
    with repo.engine.connect() as conn:
        rep_rows = conn.execute(
            select(reps.c.id, reps.c.name, reps.c.color)
            .where(reps.c.owner_user_id == owner, reps.c.is_active == 1)
            .order_by(reps.c.updated_at.desc())
        ).all()
        ids = [row.id for row in rep_rows]
        node_rows = conn.execute(
            select(nodes.c.id, nodes.c.repertoire_id, nodes.c.parent_id, nodes.c.uci,
                   nodes.c.is_enabled, nodes.c.is_mainline)
            .where(nodes.c.repertoire_id.in_(ids))
        ).all() if ids else []
    by_rep: dict[str, list[Any]] = {}
    for row in node_rows:
        by_rep.setdefault(row.repertoire_id, []).append(row)
    return {
        "repertoires": [
            {"id": row.id, "name": row.name, "color": row.color, "nodes": _slim_nodes(by_rep.get(row.id, []))}
            for row in rep_rows
        ],
    }
