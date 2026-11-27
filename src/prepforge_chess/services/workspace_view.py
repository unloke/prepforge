"""Build-workspace serialization — a pure view over a stored repertoire tree.

Turns a stored repertoire tree into the JSON payload the SPA's Build view consumes
(``/api/build/load``). It computes **no chess** and reads **no training state**:
the owner's per-node mastery and health badge are Train's projection
(``services.training_colour``), served on their own.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, Optional

from prepforge_chess.core.models import EngineEvaluation, OpeningNode, Repertoire
from prepforge_chess.storage import codec
from prepforge_chess.storage.ports import RepertoireReader

_EMPTY_SUMMARY = {"added_nodes": 0, "updated_nodes": 0, "high_probability_unprepared": 0}


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


def opening_node_to_json(node: OpeningNode, depth: int) -> Dict[str, Any]:
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
    }


def build_workspace_payload(
    repository: RepertoireReader,
    repertoire_id: str,
    *,
    selected_node_id: Optional[str] = None,
    summary: Optional[Dict[str, int]] = None,
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
    walked = list(repertoire.root_node.walk_with_depth())
    if selected_node_id:
        selected = next((node for node, _ in walked if node.id == selected_node_id), None)
        if selected is None:
            raise ValueError("opening node not found: {0}".format(selected_node_id))
    else:
        selected = repertoire.root_node
    return {
        "repertoire_id": repertoire.id,
        "name": repertoire.name,
        "color": repertoire.color.value,
        "selected_node_id": selected.id,
        "selected_fen": selected.fen,
        "summary": summary or dict(_EMPTY_SUMMARY),
        "nodes_total": len(walked),
        "revision": revision,
        "nodes": [opening_node_to_json(node, depth) for node, depth in walked],
    }


def build_workspace_changes(
    repository: RepertoireReader,
    repertoire_id: str,
    node_ids: Iterable[str],
) -> Dict[str, Any]:
    """The part of the Build payload a change feed needs: the current state of
    ``node_ids`` (those still in the tree) and the tree size.

    Loads the tree structurally and replays SAN/FEN only along the paths to the
    written nodes, so a catch-up after a one-move edit doesn't serialize (or
    replay) the whole tree. Node JSON matches ``build_workspace_payload``.
    Raises ``ValueError`` if the repertoire does not exist."""
    revision = repository.repertoire_reply_revision(repertoire_id)
    repertoire = repository.load_repertoire(repertoire_id, hydrate=False)
    if repertoire is None:
        raise ValueError("repertoire not found: {0}".format(repertoire_id))
    walked = list(repertoire.root_node.walk_with_depth())
    wanted = set(node_ids)
    codec.hydrate_opening_paths(repertoire.root_node, wanted)
    return {
        "nodes_total": len(walked),
        "revision": revision,
        "nodes": [opening_node_to_json(node, depth) for node, depth in walked if node.id in wanted],
    }
