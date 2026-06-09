"""Build-workspace serialization — a pure view over stored repertoire data.

Turns a stored repertoire (tree + training progress) into the JSON payload the SPA's
Build view consumes. It computes **no chess**: it reads the persisted tree, asks the
(now Maia-free) ``OpeningBuilderService`` for a ``tree_report`` (pure traversal), and
layers mastery/health on top. Shared by the new FastAPI ``/api/build/load`` and the
legacy ``web/server.py`` so the two cannot diverge during the strangler migration.
"""
from __future__ import annotations

from typing import Any, Dict, Iterator, Optional

from prepforge_chess.core.models import EngineEvaluation, OpeningNode
from prepforge_chess.services.opening_builder import OpeningBuilderService, OpeningTreeItem
from prepforge_chess.services.progress import compute_health, mastery_map
from prepforge_chess.storage.repositories import PrepForgeRepository

_EMPTY_SUMMARY = {"added_nodes": 0, "updated_nodes": 0, "high_probability_unprepared": 0}


def _walk(node: OpeningNode) -> Iterator[OpeningNode]:
    yield node
    for child in node.children:
        yield from _walk(child)


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


def opening_item_to_json(
    item: OpeningTreeItem, node: OpeningNode, mastery: Optional[str] = None
) -> Dict[str, Any]:
    move = node.move
    return {
        "id": item.node_id,
        "parent_id": item.parent_id,
        "depth": item.depth,
        "san": item.san,
        "uci": item.uci,
        "fen": node.fen,
        "fen_before": move.fen_before if move is not None else None,
        "fen_after": move.fen_after if move is not None else node.fen,
        "move_number": move.move_number if move is not None else 1,
        "ply": move.ply if move is not None else 0,
        "move_side": move.side_to_move.value if move is not None else None,
        "side_to_move": node.side_to_move.value,
        "source": item.source.value,
        "is_mainline": item.is_mainline,
        "is_prepared": item.is_prepared,
        "is_enabled": item.is_enabled,
        "maia_probability": item.maia_probability,
        "engine_evaluation": engine_eval_to_json(node.engine_evaluation),
        "tags": item.tags,
        "comment": item.comment,
        "arrows": list(node.arrows),
        "circles": list(node.circles),
        "mastery": mastery,
    }


def build_workspace_payload(
    repository: PrepForgeRepository,
    repertoire_id: str,
    *,
    selected_node_id: Optional[str] = None,
    summary: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    """The Build-view payload for one repertoire. Raises ``ValueError`` if the
    repertoire (or a given ``selected_node_id``) does not exist."""
    repertoire = repository.load_repertoire(repertoire_id)
    if repertoire is None:
        raise ValueError("repertoire not found: {0}".format(repertoire_id))
    # Maia-free: tree_report is a pure traversal of the stored tree (no engine/model).
    report = OpeningBuilderService(repository).tree_report(repertoire.id, include_disabled=True)
    nodes_by_id = {node.id: node for node in _walk(repertoire.root_node)}
    if selected_node_id:
        selected = nodes_by_id.get(selected_node_id)
        if selected is None:
            raise ValueError("opening node not found: {0}".format(selected_node_id))
    else:
        selected = repertoire.root_node
    progress_by_id = {p.node_id: p for p in repository.list_training_progress(repertoire.id)}
    mastery = mastery_map(repertoire.root_node, repertoire.color, progress_by_id)
    health = compute_health(repertoire.root_node, repertoire.color, progress_by_id)
    return {
        "repertoire_id": repertoire.id,
        "name": repertoire.name,
        "color": repertoire.color.value,
        "selected_node_id": selected.id,
        "selected_fen": selected.fen,
        "summary": summary or dict(_EMPTY_SUMMARY),
        "nodes_total": report.total_nodes,
        "health": health.to_dict(),
        "nodes": [
            opening_item_to_json(item, nodes_by_id[item.node_id], mastery.get(item.node_id))
            for item in report.visible_nodes
        ],
    }
