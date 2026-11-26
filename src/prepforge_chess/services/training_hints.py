"""Hint text for a trainer card: the author's note, else a heuristic.

Shared by the smart trainer (which builds the prompt) and the Train router
(which answers a hint request); neither depends on the view serializers.
"""
from __future__ import annotations

from typing import Optional

import chess

from prepforge_chess.core.models import OpeningNode


def piece_name_at(fen: str, uci: str) -> Optional[str]:
    """Name of the piece a UCI move picks up ("knight", ...); ``None`` when the
    FEN/square doesn't resolve — a missing hint, not an error."""
    try:
        piece = chess.Board(fen).piece_at(chess.parse_square(uci[:2]))
    except Exception:  # noqa: BLE001 - malformed FEN/UCI just means no hint
        return None
    return chess.piece_name(piece.piece_type) if piece is not None else None


def node_annotation(node: OpeningNode) -> str:
    """The author's own strategy note for a move: its idea, plan or comment."""
    return (node.strategic_idea or node.typical_plan or (node.comment or "")).strip()


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
