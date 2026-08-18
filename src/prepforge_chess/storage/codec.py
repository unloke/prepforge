"""Compact encode/decode for PrepForge persistent chess objects.

Authoritative on disk:
* a game is ``initial_fen`` + a UCI move blob (plus sparse per-ply annotations);
* a position is the full 6-field FEN (placement, side, castling, EP, clocks);
* an engine/Maia-style eval is (position, engine, depth, nodes, time_ms);
* an opening node is (parent, arriving UCI) under a repertoire ``root_fen``.

SAN, FEN-before/after, PGN, side-to-move, move numbers, and legal-move lists
are derived on read. Debug helpers in this module turn compact rows back into
readable dicts; raw DB rows are not required to be pretty.
"""
from __future__ import annotations

import hashlib
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import chess
import chess.pgn

from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    Game,
    GameResult,
    MoveClassification,
    MoveRecord,
    MoveSource,
    OpeningNode,
)


# Full starting FEN, including clocks. Identity never drops clocks, castling, or EP.
STARTING_FEN = chess.STARTING_FEN


def canonicalize_fen(fen: str) -> str:
    """Normalize a FEN through python-chess without dropping any of the 6 fields."""
    return chess.Board(fen).fen()


def position_identity(fen: str) -> Tuple[str, str, str, str, int, int]:
    """Six-field identity: placement, side, castling, ep, halfmove, fullmove."""
    board = chess.Board(fen)
    placement, side, castling, ep, half, full = board.fen().split(" ")
    return placement, side, castling, ep, int(half), int(full)


def position_key(fen: str) -> str:
    """Stable textual key: the canonical full FEN. Not a truncated hash."""
    return canonicalize_fen(fen)


def encode_uci_sequence(moves: Iterable[str]) -> str:
    return " ".join(uci for uci in moves if uci)


def decode_uci_sequence(blob: Optional[str]) -> List[str]:
    if not blob:
        return []
    return [part for part in blob.split() if part]


def encode_pv(pv: Optional[Sequence[str]]) -> str:
    if not pv:
        return ""
    return " ".join(pv)


def decode_pv(blob: Optional[str]) -> List[str]:
    if not blob:
        return []
    return [part for part in blob.split() if part]


def encode_wdl(wdl: Optional[Mapping[str, float]]) -> Optional[Tuple[int, int, int]]:
    """Store WDL as permille integers so keys are not repeated as JSON."""
    if not wdl:
        return None
    def _milli(name: str) -> int:
        raw = wdl.get(name, 0.0)
        return int(round(float(raw) * 1000.0))
    return _milli("win"), _milli("draw"), _milli("loss")


def decode_wdl(
    win: Optional[int], draw: Optional[int], loss: Optional[int]
) -> Optional[Dict[str, float]]:
    if win is None and draw is None and loss is None:
        return None
    return {
        "win": (win or 0) / 1000.0,
        "draw": (draw or 0) / 1000.0,
        "loss": (loss or 0) / 1000.0,
    }


# Stored in place of NULL on depth/nodes/time_ms so UNIQUE(position, engine, …)
# is NULL-safe on SQLite and Postgres (NULL != NULL in a unique constraint).
# Real engine limits are non-negative; -1 is never a configured search bound.
UNSET_SEARCH_LIMIT = -1


def encode_search_limit(value: Optional[int]) -> int:
    """Persist an optional search bound as a non-null unique-key integer."""
    if value is None:
        return UNSET_SEARCH_LIMIT
    if value < 0:
        raise ValueError("search limit must be >= 0 or None, got {0}".format(value))
    return int(value)


def decode_search_limit(value: Optional[int]) -> Optional[int]:
    if value is None or value == UNSET_SEARCH_LIMIT:
        return None
    return int(value)


def analysis_identity(
    fen: str,
    engine: str,
    depth: Optional[int],
    nodes: Optional[int],
    time_ms: Optional[int],
) -> Tuple[str, str, Optional[int], Optional[int], Optional[int]]:
    """Identity for a cached analysis: position + config that changes the result."""
    return (position_key(fen), engine, depth, nodes, time_ms)


def analysis_identity_digest(
    fen: str,
    engine: str,
    depth: Optional[int],
    nodes: Optional[int],
    time_ms: Optional[int],
) -> str:
    payload = "{0}|{1}|{2}|{3}|{4}".format(
        position_key(fen),
        engine,
        "" if depth is None else depth,
        "" if nodes is None else nodes,
        "" if time_ms is None else time_ms,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _color_from_board(board: chess.Board) -> Color:
    return Color.WHITE if board.turn == chess.WHITE else Color.BLACK


def replay_uci(
    fen: str,
    uci: str,
    *,
    source: MoveSource = MoveSource.MANUAL,
    ply: Optional[int] = None,
) -> MoveRecord:
    """Apply one UCI from ``fen`` and return a fully hydrated MoveRecord."""
    board = chess.Board(fen)
    try:
        move = chess.Move.from_uci(uci)
    except ValueError as exc:
        raise ValueError("invalid UCI move: {0}".format(uci)) from exc
    if move not in board.legal_moves:
        raise ValueError("illegal move {0} for FEN {1}".format(uci, board.fen()))
    fen_before = board.fen()
    san = board.san(move)
    side = _color_from_board(board)
    move_number = board.fullmove_number
    record_ply = ply if ply is not None else (board.fullmove_number - 1) * 2 + (
        1 if board.turn == chess.WHITE else 2
    )
    board.push(move)
    return MoveRecord(
        uci=move.uci(),
        san=san,
        fen_before=fen_before,
        fen_after=board.fen(),
        move_number=move_number,
        ply=record_ply,
        side_to_move=side,
        source=source,
    )


def rebuild_moves(
    initial_fen: str,
    uci_list: Sequence[str],
    annotations: Optional[Mapping[int, Mapping[str, Any]]] = None,
) -> List[MoveRecord]:
    """Replay a UCI sequence and overlay persisted per-ply annotations."""
    notes = annotations or {}
    fen = canonicalize_fen(initial_fen)
    out: List[MoveRecord] = []
    for index, uci in enumerate(uci_list, start=1):
        note = notes.get(index) or notes.get(str(index)) or {}
        source = note.get("source", MoveSource.IMPORTED_PGN)
        if not isinstance(source, MoveSource):
            source = MoveSource(source)
        record = replay_uci(fen, uci, source=source, ply=index)
        classification = note.get("classification", MoveClassification.UNKNOWN)
        if not isinstance(classification, MoveClassification):
            classification = MoveClassification(classification)
        record.classification = classification
        record.comment = note.get("comment")
        record.tags = list(note.get("tags") or [])
        record.engine_eval_before = note.get("engine_eval_before")
        record.engine_eval_after = note.get("engine_eval_after")
        record.best_move_uci = note.get("best_move_uci")
        record.best_move_eval = note.get("best_move_eval")
        fen = record.fen_after
        out.append(record)
    return out


def game_uci_blob(game: Game) -> str:
    return encode_uci_sequence(move.uci for move in game.moves)


def move_needs_row(move: MoveRecord) -> bool:
    """True when a ply carries anything that cannot be rebuilt from UCI + FEN."""
    if move.classification is not MoveClassification.UNKNOWN:
        return True
    if move.comment:
        return True
    if move.tags:
        return True
    if move.engine_eval_before is not None or move.engine_eval_after is not None:
        return True
    if move.best_move_eval is not None or move.best_move_uci:
        return True
    if move.source not in (MoveSource.IMPORTED_PGN, MoveSource.LICHESS_GAME, MoveSource.HUMAN_GAME):
        return True
    return False


def export_pgn(game: Game) -> str:
    """Rebuild a PGN from authoritative headers + UCI sequence."""
    board = chess.Board(game.initial_fen)
    pgn_game = chess.pgn.Game()
    if game.initial_fen != STARTING_FEN:
        pgn_game.setup(board)
    headers = dict(game.tags or {})
    if game.white:
        headers["White"] = game.white
    if game.black:
        headers["Black"] = game.black
    headers["Result"] = game.result.value if isinstance(game.result, GameResult) else str(game.result)
    if game.event:
        headers["Event"] = game.event
    if game.site:
        headers["Site"] = game.site
    if game.played_at is not None:
        headers.setdefault("Date", game.played_at.strftime("%Y.%m.%d"))
    for key, value in headers.items():
        if value is None:
            continue
        pgn_game.headers[str(key)] = str(value)
    node: chess.pgn.GameNode = pgn_game
    replay = chess.Board(game.initial_fen)
    for record in game.moves:
        move = chess.Move.from_uci(record.uci)
        node = node.add_variation(move)
        if record.comment:
            node.comment = record.comment
        replay.push(move)
    return pgn_game.accept(chess.pgn.StringExporter(headers=True, variations=False, comments=True))


def eval_to_debug_dict(evaluation: EngineEvaluation) -> Dict[str, Any]:
    return {
        "engine": evaluation.engine,
        "depth": evaluation.depth,
        "nodes": evaluation.nodes,
        "time_ms": evaluation.time_ms,
        "score_cp": evaluation.score_cp,
        "mate_in": evaluation.mate_in,
        "best_move_uci": evaluation.best_move_uci,
        "pv": list(evaluation.pv),
        "wdl": dict(evaluation.wdl) if evaluation.wdl else None,
    }


def hydrate_opening_tree(
    root_fen: str,
    nodes: Dict[str, OpeningNode],
    arriving_uci: Mapping[str, Optional[str]],
) -> Optional[OpeningNode]:
    """Fill fen / side / move on opening nodes by walking parent → arriving UCI."""
    children: Dict[Optional[str], List[OpeningNode]] = {}
    for node in nodes.values():
        children.setdefault(node.parent_id, []).append(node)

    root = next((n for n in nodes.values() if n.parent_id is None), None)
    if root is None:
        return None
    root.fen = canonicalize_fen(root_fen)
    root.side_to_move = _color_from_board(chess.Board(root.fen))

    def walk(node: OpeningNode) -> None:
        for child in children.get(node.id, []):
            uci = arriving_uci.get(child.id)
            if not uci:
                raise ValueError("opening node {0} is missing arriving UCI".format(child.id))
            source = child.source
            record = replay_uci(node.fen, uci, source=source)
            if child.engine_evaluation is not None:
                record.engine_eval_after = child.engine_evaluation
            child.move = record
            child.fen = record.fen_after
            child.side_to_move = _color_from_board(chess.Board(child.fen))
            node.children.append(child)
            walk(child)

    root.children = []
    walk(root)
    return root
