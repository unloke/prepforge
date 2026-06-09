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
from typing import Any, Optional

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import OpeningNode
from prepforge_chess.services.training import TrainingLine, TrainingPrompt


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
