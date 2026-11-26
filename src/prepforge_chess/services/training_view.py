"""Maia-free serializers for the Train view (Phase 2b-2d-v).

Mirrors ``workspace_view.py`` / ``analysis_view.py``: pure data shaping for the
trainer's JSON payloads, with no engine dependency. ``TrainingService`` itself only
walks the stored repertoire tree (python-chess move legality, no Stockfish/Maia), so
the whole Train surface already fits the "server never computes chess" model.
"""
from __future__ import annotations

from typing import Any, Optional

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.services.training import TrainingLine, TrainingPrompt
from prepforge_chess.services.training_smart import SmartPrompt


def prompt_to_json(
    prompt: Optional[TrainingPrompt], chess: ChessCore
) -> Optional[dict[str, Any]]:
    if prompt is None:
        return None
    return {
        "session_id": prompt.session_id,
        "repertoire_id": prompt.repertoire_id,
        "line_node_id": prompt.line_node_id,
        "current_index": prompt.current_index,
        "total_lines": prompt.total_lines,
        "fen_before": prompt.fen_before,
        "remaining_mistakes": prompt.remaining_mistakes,
        "legal_moves": chess.legal_moves(prompt.fen_before),
    }


def training_line_to_json(line: TrainingLine) -> dict[str, Any]:
    return {
        "line_node_id": line.line_node_id,
        "node_ids": line.node_ids,
        "own_move_node_ids": line.own_move_node_ids,
        "ply_count": len(line.node_ids),
        "own_move_count": len(line.own_move_node_ids),
    }



def smart_prompt_to_json(
    prompt: Optional[SmartPrompt], chess_core: ChessCore
) -> Optional[dict[str, Any]]:
    """Smart-trainer card prompt. Ships the
    expected move and hint texts: it's the player's own repertoire, and the
    client runs the teach/retry flows locally without extra round-trips."""
    if prompt is None:
        return None
    return {
        "session_id": prompt.session_id,
        "repertoire_id": prompt.repertoire_id,
        "card_index": prompt.card_index,
        "total_cards": prompt.total_cards,
        "kind": prompt.kind,
        "target_index": prompt.target_index,
        "targets_total": prompt.targets_total,
        "expected_node_id": prompt.expected_node_id,
        "expected_uci": prompt.expected_move_uci,
        "expected_san": prompt.expected_move_san,
        "fen_before": prompt.fen_before,
        "start_fen": prompt.start_fen,
        "run_in": [
            {"uci": node.move.uci, "san": node.move.san}
            for node in prompt.run_in
            if node.move is not None
        ],
        "hint": {
            "strategy": prompt.hint_strategy,
            "piece": prompt.hint_piece,
            # Author annotation vs generic heuristic — the client shows author words
            # verbatim, but upgrades heuristics to a board-derived explanation.
            "annotated": prompt.hint_is_annotation,
        },
        "legal_moves": chess_core.legal_moves(prompt.fen_before),
    }
