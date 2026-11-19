"""Build-workspace serialization — a pure view over stored repertoire data.

Turns a stored repertoire (tree + training progress) into the JSON payload the SPA's
Build view consumes. It computes **no chess**: it traverses the persisted tree once and
layers mastery/health on top for FastAPI ``/api/build/load``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from prepforge_chess.core.models import EngineEvaluation, OpeningNode, Repertoire
from prepforge_chess.services.progress import compute_health, mastery_map
from prepforge_chess.storage.repositories.repertoires import RepertoireRepository

_EMPTY_SUMMARY = {"added_nodes": 0, "updated_nodes": 0, "high_probability_unprepared": 0}


def _walk_with_depth(root: OpeningNode) -> List[Tuple[OpeningNode, int]]:
    """Iterative pre-order DFS producing (node, depth) pairs without intermediate items."""
    out: List[Tuple[OpeningNode, int]] = []
    stack: List[Tuple[OpeningNode, int]] = [(root, 0)]
    while stack:
        node, depth = stack.pop()
        out.append((node, depth))
        next_depth = depth + 1
        for child in reversed(node.children):
            stack.append((child, next_depth))
    return out


def engine_eval_to_json(ev: Optional[EngineEvaluation]) -> Optional[Dict[str, Any]]:
    """Serialize an EngineEvaluation (White-POV), or None. The browser Build Generate
    planner only needs null-vs-present to merge fill-only-when-null, but the full fields
    keep the payload self-describing for apply-plan."""
    if ev is None:
        return None
    return {
        "engine": ev.engine,
        "depth": ev.depth,
        "score_cp": ev.score_cp,
        "mate_in": ev.mate_in,
        "best_move_uci": ev.best_move_uci,
        "pv": list(ev.pv),
        "wdl": dict(ev.wdl) if ev.wdl else None,
    }


def opening_node_to_json(
    node: OpeningNode, depth: int, mastery: Optional[str] = None
) -> Dict[str, Any]:
    move = node.move
    return {
        "id": node.id,
        "parent_id": node.parent_id,
        "depth": depth,
        "san": move.san if move is not None else "root",
        "uci": move.uci if move is not None else None,
        "fen": node.fen,
        "fen_before": move.fen_before if move is not None else None,
        "fen_after": move.fen_after if move is not None else node.fen,
        "move_number": move.move_number if move is not None else 1,
        "ply": move.ply if move is not None else 0,
        "move_side": move.side_to_move.value if move is not None else None,
        "side_to_move": node.side_to_move.value,
        "source": node.source.value,
        "is_mainline": node.is_mainline,
        "is_prepared": node.is_user_prepared_move,
        "is_enabled": node.is_enabled,
        "maia_probability": node.maia_probability,
        "engine_evaluation": engine_eval_to_json(node.engine_evaluation),
        "tags": list(node.tags),
        "comment": node.comment,
        "arrows": list(node.arrows),
        "circles": list(node.circles),
        "mastery": mastery,
    }


def build_workspace_payload(
    repository: RepertoireRepository,
    repertoire_id: str,
    *,
    selected_node_id: Optional[str] = None,
    summary: Optional[Dict[str, int]] = None,
    owner_user_id: str | None = None,
    repertoire: Optional[Repertoire] = None,
) -> Dict[str, Any]:
    """The Build-view payload for one repertoire. Raises ``ValueError`` if the
    repertoire (or a given ``selected_node_id``) does not exist."""
    # Read before the tree: the payload then holds at least every write up to
    # its revision, so a device catching up from it never skips one.
    revision = repository.repertoire_reply_revision(repertoire_id)
    repertoire = repertoire or repository.load_repertoire(repertoire_id)
    if repertoire is None:
        raise ValueError("repertoire not found: {0}".format(repertoire_id))
    walked = _walk_with_depth(repertoire.root_node)
    if selected_node_id:
        selected = next((node for node, _ in walked if node.id == selected_node_id), None)
        if selected is None:
            raise ValueError("opening node not found: {0}".format(selected_node_id))
    else:
        selected = repertoire.root_node
    progress_by_id = (
        {
            p.node_id: p
            for p in repository.list_training_progress(
                repertoire.id, owner_user_id=owner_user_id
            )
        }
        if owner_user_id
        else {}
    )
    mastery = mastery_map(repertoire.root_node, repertoire.color, progress_by_id)
    health = compute_health(repertoire.root_node, repertoire.color, progress_by_id, states=mastery)
    # Refresh the dashboard's cached badge off this already-computed walk. Every Build
    # mutation funnels back through here, so the cache stays current with no extra cost.
    # D-01: the cache records computed_at + tree revision so readers can tell how
    # fresh the static numbers are; time-dependent numbers (due) are recomputed
    # live wherever they are displayed (see repository.due_counts_by_repertoire).
    cached = getattr(repertoire, "_cached_health", None) or {}
    cached_static = {k: v for k, v in cached.items() if k not in ("computed_at", "revision")}
    if cached_static != health.to_dict() or cached.get("revision") != revision:
        health_data = dict(health.to_dict())
        health_data["computed_at"] = datetime.now(timezone.utc).isoformat()
        health_data["revision"] = revision
        repository.set_repertoire_health(
            repertoire.id, health_data,
            expected_cache=getattr(repertoire, "_cached_health", None), cache_snapshot=True,
        )
        repertoire._cached_health = health_data
    health_data = getattr(repertoire, "_cached_health", None) or dict(health.to_dict())
    return {
        "repertoire_id": repertoire.id,
        "name": repertoire.name,
        "color": repertoire.color.value,
        "selected_node_id": selected.id,
        "selected_fen": selected.fen,
        "summary": summary or dict(_EMPTY_SUMMARY),
        "nodes_total": len(walked),
        "revision": revision,
        "health": health_data,
        "nodes": [
            opening_node_to_json(node, depth, mastery.get(node.id))
            for node, depth in walked
        ],
    }
