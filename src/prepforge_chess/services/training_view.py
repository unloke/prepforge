"""Maia-free serializers for the Train view (Phase 2b-2d-v).

Mirrors ``workspace_view.py`` / ``analysis_view.py``: pure data shaping for the
trainer's JSON payloads, with no engine dependency. ``TrainingService`` itself only
walks the stored repertoire tree (python-chess move legality, no Stockfish/Maia), so
the whole Train surface already fits the "server never computes chess" model. The
legacy ``_prompt_to_json`` / ``_training_line_to_json`` / ``_heuristic_strategy`` live
on here and are deleted with ``web/server.py``.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import TYPE_CHECKING, Any, Optional

import chess

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import OpeningNode
from prepforge_chess.services.training import TrainingLine, TrainingPrompt

if TYPE_CHECKING:  # avoid a runtime import cycle with training_smart
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


def piece_name_at(fen: str, uci: str) -> Optional[str]:
    """Name of the piece a UCI move picks up ("knight", ...); ``None`` when the
    FEN/square doesn't resolve — a missing hint, not an error."""
    try:
        piece = chess.Board(fen).piece_at(chess.parse_square(uci[:2]))
    except Exception:  # noqa: BLE001 - malformed FEN/UCI just means no hint
        return None
    return chess.piece_name(piece.piece_type) if piece is not None else None


def smart_prompt_to_json(
    prompt: Optional["SmartPrompt"], chess_core: ChessCore
) -> Optional[dict[str, Any]]:
    """Smart-trainer card prompt. Unlike the legacy prompt this ships the
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


def walk_opening_nodes(root: OpeningNode) -> Iterator[OpeningNode]:
    yield root
    for child in root.children:
        yield from walk_opening_nodes(child)


def heuristic_strategy(san: Optional[str], piece_name: Optional[str]) -> str:
    text = san or ""
    if text.startswith("O-O"):
        return "King safety — get your king castled."
    low = text.lower()
    if piece_name == "pawn" and any(sq in low for sq in ("d4", "e4", "d5", "e5", "c4", "c5")):
        return "Fight for the centre."
    if piece_name in ("knight", "bishop"):
        return "Develop a piece toward the centre, with tempo if you can."
    if piece_name == "queen":
        return "Bring the queen into play — but don't expose her early."
    if piece_name == "rook":
        return "Activate a rook (open file / connect them)."
    if piece_name == "pawn":
        return "A pawn move to shape the structure to your plan."
    return "Follow your preparation for this position."
