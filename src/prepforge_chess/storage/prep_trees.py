"""The preparation book: every active repertoire an owner has, as slim trees.

Scout and Analyze only ask "does my tree play this move here?", so they need
each node's place in the tree and nothing else: no SAN/FEN replay, no engine
evaluations, no training progress or health. One read covers every active
repertoire, where each feature used to load them one by one through
``/api/build/load``.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.engine import Engine

from prepforge_chess.storage import sa_tables as t


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


def active_prep_trees(engine: Engine, owner_user_id: str) -> list[dict[str, Any]]:
    """Every active repertoire ``owner_user_id`` owns, newest edit first, as
    ``{id, name, color, nodes}`` with ``{id, parent_id, uci, depth, is_enabled,
    is_mainline}`` nodes."""
    reps, nodes = t.repertoires, t.opening_nodes
    with engine.connect() as conn:
        rep_rows = conn.execute(
            select(reps.c.id, reps.c.name, reps.c.color)
            .where(reps.c.owner_user_id == owner_user_id, reps.c.is_active == 1)
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
    return [
        {"id": row.id, "name": row.name, "color": row.color, "nodes": _slim_nodes(by_rep.get(row.id, []))}
        for row in rep_rows
    ]
