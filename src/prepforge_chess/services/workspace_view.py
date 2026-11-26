"""Build-workspace serialization — a pure view over stored repertoire data.

Turns a stored repertoire (tree + training progress) into the JSON payload the SPA's
Build view consumes. It computes **no chess**: it traverses the persisted tree once and
layers mastery/health on top for FastAPI ``/api/build/load``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional

from prepforge_chess.core.models import EngineEvaluation, OpeningNode, Repertoire
from prepforge_chess.services.progress import compute_health, mastery_map
from prepforge_chess.storage import codec
from prepforge_chess.storage.ports import BuildPayloadStore

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
    repository: BuildPayloadStore,
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
    walked = list(repertoire.root_node.walk_with_depth())
    if selected_node_id:
        selected = next((node for node, _ in walked if node.id == selected_node_id), None)
        if selected is None:
            raise ValueError("opening node not found: {0}".format(selected_node_id))
    else:
        selected = repertoire.root_node
    mastery, health_data = _owner_training_colour(repository, repertoire, revision, owner_user_id)
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


def _owner_training_colour(
    repository: BuildPayloadStore,
    repertoire: Repertoire,
    revision: Optional[int],
    owner_user_id: Optional[str],
) -> tuple[Dict[str, str], Dict[str, Any]]:
    """Per-node mastery and the health badge against the owner's progress.

    Uses only the tree's shape (no SAN/FEN), so a structurally loaded tree gives
    the same answer as a hydrated one."""
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
    return mastery, health_data


def build_workspace_changes(
    repository: BuildPayloadStore,
    repertoire_id: str,
    node_ids: Iterable[str],
    *,
    owner_user_id: str | None = None,
) -> Dict[str, Any]:
    """The part of the Build payload a change feed needs: the current state of
    ``node_ids`` (those still in the tree), the tree size and the health badge.

    Loads the tree structurally and replays SAN/FEN only along the paths to the
    written nodes, so a catch-up after a one-move edit doesn't serialize (or
    replay) the whole tree. Node JSON and health match ``build_workspace_payload``.
    Raises ``ValueError`` if the repertoire does not exist."""
    revision = repository.repertoire_reply_revision(repertoire_id)
    repertoire = repository.load_repertoire(repertoire_id, hydrate=False)
    if repertoire is None:
        raise ValueError("repertoire not found: {0}".format(repertoire_id))
    walked = list(repertoire.root_node.walk_with_depth())
    wanted = set(node_ids)
    codec.hydrate_opening_paths(repertoire.root_node, wanted)
    mastery, health_data = _owner_training_colour(repository, repertoire, revision, owner_user_id)
    return {
        "nodes_total": len(walked),
        "revision": revision,
        "health": health_data,
        "nodes": [
            opening_node_to_json(node, depth, mastery.get(node.id))
            for node, depth in walked
            if node.id in wanted
        ],
    }
