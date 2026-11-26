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
import io
import json
import struct
import zlib
from dataclasses import asdict, fields
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
    """The PV text the fingerprint hashes: what :func:`pack_pv` stores, so a
    loaded evaluation re-saves onto its own row."""
    return " ".join(unpack_pv(pack_pv(pv)))


_PROMOTION_SUFFIX = ("",) + tuple(chess.PIECE_SYMBOLS[1:]) + ("",)


def pack_pv(pv: Optional[Sequence[str]]) -> bytes:
    """PV as 2 bytes per move: from | to << 6 | promotion << 12.

    Case-insensitive; empty entries are skipped and the line stops at the
    first entry that is not a UCI move, since nothing after it is playable.
    """
    out = bytearray()
    for uci in pv or ():
        uci = (uci or "").lower()
        if not uci:
            continue
        if uci == "0000":
            word = 0
        else:
            try:
                if len(uci) not in (4, 5):
                    raise ValueError(uci)
                word = chess.parse_square(uci[:2]) | chess.parse_square(uci[2:4]) << 6
                if len(uci) == 5:
                    word |= chess.PIECE_SYMBOLS.index(uci[4]) << 12
            except ValueError:
                break
        out += word.to_bytes(2, "little")
    return bytes(out)


def unpack_pv(blob: Optional[bytes]) -> List[str]:
    if not blob:
        return []
    names = chess.SQUARE_NAMES
    return [
        names[word & 63] + names[word >> 6 & 63] + _PROMOTION_SUFFIX[word >> 12] if word else "0000"
        for word in struct.unpack("<{0}H".format(len(blob) // 2), blob)
    ]


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        low = value & 0x7F
        value >>= 7
        if value:
            out.append(low | 0x80)
        else:
            out.append(low)
            return bytes(out)


def _read_varint(data: bytes, offset: int) -> Tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, offset


def pack_position(fen: str) -> bytes:
    """The positions-catalog key: a lossless binary form of ``position_key(fen)``.

    occupied (8 bytes) | turn + en-passant file (1) | castling rooks on ranks
    1 and 8 (2) | one nibble per occupied square, ascending (piece type, +8 for
    black) | halfmove and fullmove varints. About half the canonical FEN text.
    """
    board = chess.Board(fen)
    ep = board.ep_square if board.has_legal_en_passant() else None
    rights = board.clean_castling_rights()
    out = bytearray(board.occupied.to_bytes(8, "little"))
    out.append((0 if board.turn == chess.WHITE else 1) | (0 if ep is None else chess.square_file(ep) + 1) << 1)
    out.append(rights & 0xFF)
    out.append(rights >> 56 & 0xFF)
    nibbles = []
    for square in chess.scan_forward(board.occupied):
        piece = board.piece_at(square)
        nibbles.append(piece.piece_type | (0 if piece.color == chess.WHITE else 8))
    if len(nibbles) % 2:
        nibbles.append(0)
    out += bytes(nibbles[i] | nibbles[i + 1] << 4 for i in range(0, len(nibbles), 2))
    out += _varint(board.halfmove_clock) + _varint(board.fullmove_number)
    return bytes(out)


def unpack_position(key: bytes) -> str:
    """Inverse of :func:`pack_position`: the canonical six-field FEN."""
    occupied = int.from_bytes(key[:8], "little")
    flags = key[8]
    board = chess.Board(None)
    squares = list(chess.scan_forward(occupied))
    offset = 11
    for index, square in enumerate(squares):
        nibble = key[offset + index // 2] >> (4 * (index % 2)) & 0x0F
        board.set_piece_at(square, chess.Piece(nibble & 7, chess.BLACK if nibble & 8 else chess.WHITE))
    offset += (len(squares) + 1) // 2
    board.turn = chess.BLACK if flags & 1 else chess.WHITE
    board.castling_rights = key[9] | key[10] << 56
    ep_file = flags >> 1
    if ep_file:
        board.ep_square = chess.square(ep_file - 1, 5 if board.turn == chess.WHITE else 2)
    board.halfmove_clock, offset = _read_varint(key, offset)
    board.fullmove_number, offset = _read_varint(key, offset)
    return board.fen()


def encode_wdl(wdl: Optional[Mapping[str, float]]) -> Optional[Tuple[int, int, int]]:
    """Store WDL as permille integers so keys are not repeated as JSON."""
    if not wdl:
        return None
    win, draw, loss = (int(round(float(wdl.get(name, 0.0)) * 1000.0)) for name in ("win", "draw", "loss"))
    return win, draw, loss


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


def evaluation_fingerprint(
    *,
    engine: str,
    position_fen: str,
    depth: int,
    nodes: int,
    time_ms: int,
    score_cp: Optional[int],
    mate_in: Optional[int],
    best_move_uci: Optional[str],
    pv: str,
    wdl_win: Optional[int],
    wdl_draw: Optional[int],
    wdl_loss: Optional[int],
) -> str:
    """Digest of everything that defines one evaluation snapshot.

    Commits to the full snapshot identity, not just the result:

    - engine / artifact version — the engine string is the artifact + source
      identity (e.g. ``"stockfish (browser)"`` vs a server engine name), so
      browser submissions and server engines never collide
    - position (``position_key`` form, i.e. the stored FEN)
    - actual search effort: depth / nodes / time_ms (encoded, ``None`` →
      :data:`UNSET_SEARCH_LIMIT`)
    - result: score_cp / mate_in / best_move_uci / PV / WDL

    All inputs use their STORED forms (search limits already
    :func:`encode_search_limit`-ed, PV in :func:`encode_pv` form), so identical
    content hashes identically on write and on read-back, and any different
    result (different search or different numbers) hashes differently:
    evaluation rows become immutable snapshots that still dedupe (D-01).

    Returns the digest as lowercase hex. The column stores its 32 raw bytes
    (:func:`fingerprint_bytes`); hex is what the older migration backfill and
    its tests read, so the digest's canonical spelling stays stable.
    """
    payload = {
        "engine": engine,
        "position": position_fen,
        "depth": depth,
        "nodes": nodes,
        "time_ms": time_ms,
        "score_cp": score_cp,
        "mate_in": mate_in,
        "best_move_uci": best_move_uci,
        "pv": pv,
        "wdl_win": wdl_win,
        "wdl_draw": wdl_draw,
        "wdl_loss": wdl_loss,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def fingerprint_bytes(digest: str) -> bytes:
    """The stored form of an ``evaluation_fingerprint``: its 32 raw bytes.

    The digest is the evaluations' dedupe key, so every byte of it is index
    payload; the 64-character hex spelling cost twice that for no reader.
    """
    return bytes.fromhex(digest)


_PIECE_BITBOARDS = (
    ("pawns", "P", "p"),
    ("knights", "N", "n"),
    ("bishops", "B", "b"),
    ("rooks", "R", "r"),
    ("queens", "Q", "q"),
    ("kings", "K", "k"),
)
_EMPTY_RUNS = tuple(("1" * n, str(n)) for n in range(8, 1, -1))


_STANDARD_CASTLING = (
    (chess.BB_H1, "K"),
    (chess.BB_A1, "Q"),
    (chess.BB_H8, "k"),
    (chess.BB_A8, "q"),
)


def _castling_field(board: chess.Board) -> str:
    if not board.castling_rights:
        return "-"
    if board.chess960:
        return board.castling_xfen()
    rights = board.clean_castling_rights()
    return "".join(symbol for mask, symbol in _STANDARD_CASTLING if rights & mask) or "-"


def board_fen(board: chess.Board) -> str:
    """``board.fen()`` from the bitboards, without 64 ``piece_at`` lookups.

    Serializing the position is the dominant cost of hydrating an opening tree
    (one FEN per node), and python-chess builds the placement square by square.
    """
    grid = ["1"] * 64
    white = board.occupied_co[chess.WHITE]
    black = board.occupied_co[chess.BLACK]
    for attr, upper, lower in _PIECE_BITBOARDS:
        pieces = getattr(board, attr)
        for square in chess.scan_forward(pieces & white):
            grid[square] = upper
        for square in chess.scan_forward(pieces & black):
            grid[square] = lower
    placement = "/".join("".join(grid[rank:rank + 8]) for rank in range(56, -1, -8))
    for run, digits in _EMPTY_RUNS:
        placement = placement.replace(run, digits)
    castling = _castling_field(board)
    ep = board.ep_square
    ep_name = chess.SQUARE_NAMES[ep] if ep is not None and board.has_legal_en_passant() else "-"
    return "{0} {1} {2} {3} {4} {5}".format(
        placement,
        "w" if board.turn == chess.WHITE else "b",
        castling,
        ep_name,
        board.halfmove_clock,
        board.fullmove_number,
    )


def _color_from_board(board: chess.Board) -> Color:
    return Color.WHITE if board.turn == chess.WHITE else Color.BLACK


def _replay_on_board(
    board: chess.Board,
    uci: str,
    *,
    source: MoveSource = MoveSource.MANUAL,
    ply: Optional[int] = None,
    fen_before: Optional[str] = None,
) -> MoveRecord:
    """Apply one UCI on ``board`` (leaving it pushed) and return a MoveRecord.

    Shared engine behind :func:`replay_uci` and the opening-tree walk. Callers
    that already know the current position's FEN string (e.g. its parent's
    ``fen_after``) pass it as ``fen_before`` to skip re-serializing the same
    position.
    """
    try:
        move = chess.Move.from_uci(uci)
    except ValueError as exc:
        raise ValueError("invalid UCI move: {0}".format(uci)) from exc
    if move not in board.legal_moves:
        raise ValueError("illegal move {0} for FEN {1}".format(uci, board.fen()))
    if fen_before is None:
        fen_before = board_fen(board)
    side = _color_from_board(board)
    move_number = board.fullmove_number
    record_ply = ply if ply is not None else (board.fullmove_number - 1) * 2 + (
        1 if board.turn == chess.WHITE else 2
    )
    # SAN generation already pushes to detect check/mate; keep that push rather
    # than popping it and replaying the same move a second time.
    san = board.san_and_push(move)
    return MoveRecord(
        uci=move.uci(),
        san=san,
        fen_before=fen_before,
        fen_after=board_fen(board),
        move_number=move_number,
        ply=record_ply,
        side_to_move=side,
        source=source,
    )


def replay_uci(
    fen: str,
    uci: str,
    *,
    source: MoveSource = MoveSource.MANUAL,
    ply: Optional[int] = None,
) -> MoveRecord:
    """Apply one UCI from ``fen`` and return a fully hydrated MoveRecord."""
    return _replay_on_board(chess.Board(fen), uci, source=source, ply=ply)


def rebuild_moves(
    initial_fen: str,
    uci_list: Sequence[str],
    annotations: Optional[Mapping[int, Mapping[str, Any]]] = None,
) -> List[MoveRecord]:
    """Replay a UCI sequence and overlay persisted per-ply annotations."""
    notes = annotations or {}
    fen = canonicalize_fen(initial_fen)
    board = chess.Board(fen)
    out: List[MoveRecord] = []
    for index, uci in enumerate(uci_list, start=1):
        note = notes.get(index) or notes.get(str(index)) or {}
        source = note.get("source", MoveSource.IMPORTED_PGN)
        if not isinstance(source, MoveSource):
            source = MoveSource(source)
        record = _replay_on_board(board, uci, source=source, ply=index, fen_before=fen)
        classification = note.get("classification", MoveClassification.UNKNOWN)
        if not isinstance(classification, MoveClassification):
            classification = MoveClassification(classification)
        record.classification = classification
        record.comment = note.get("comment")
        record.generated_comment = note.get("generated_comment")
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


_ENGINE_EVAL_FIELDS = tuple(f.name for f in fields(EngineEvaluation))
_ANALYSIS_FIELDS = (
    "uci", "source", "classification", "engine_eval_before", "engine_eval_after",
    "best_move_uci", "best_move_eval", "comment", "generated_comment", "tags",
)


def encode_analysis_moves(moves: Sequence[MoveRecord]) -> bytes:
    """Self-contained run snapshot; never references mutable game annotations.

    Each ply stores only what replaying the run's starting position (the first
    move's ``fen_before``) cannot rebuild: the arriving UCI, its source and the
    per-ply annotations. SAN, both FENs, ply and move number come back from
    :func:`rebuild_moves`. Identical evaluations (one per analysed position, so
    a move's "after" is the next move's "before") are pooled once and
    referenced by index instead of being repeated per ply, and
    ``best_move_eval`` — always the same object as ``engine_eval_before`` —
    reuses that pool slot.
    """
    evals: List[Dict[str, Any]] = []
    index: Dict[str, int] = {}

    def pool(evaluation: Optional[EngineEvaluation]) -> Optional[int]:
        if evaluation is None:
            return None
        payload = asdict(evaluation)
        key = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        if key not in index:
            index[key] = len(evals)
            evals.append(payload)
        return index[key]

    rows = []
    for move in moves:
        before = pool(move.engine_eval_before)
        same_best = move.best_move_eval is move.engine_eval_before
        rows.append([
            move.uci,
            move.source.value,
            move.classification.value,
            before,
            pool(move.engine_eval_after),
            move.best_move_uci,
            before if same_best else pool(move.best_move_eval),
            move.comment,
            move.generated_comment,
            list(move.tags) or None,
        ])
    body = {"i": moves[0].fen_before if moves else STARTING_FEN, "e": evals, "m": rows}
    return zlib.compress(json.dumps(body, separators=(",", ":")).encode("utf-8"), 9)


def decode_analysis_moves(payload: Optional[bytes]) -> List[MoveRecord]:
    # Older analyses have no trustworthy per-run moves. Do not attach today's
    # shared annotations to a historical summary; reanalysis creates a snapshot.
    if payload is None:
        return []
    try:
        body = json.loads(zlib.decompress(payload))
    except zlib.error as exc:
        raise ValueError("unreadable analysis snapshot") from exc
    if not isinstance(body, dict):
        raise ValueError("unreadable analysis snapshot")
    evals = [
        EngineEvaluation(**{key: value for key, value in evaluation.items() if key in _ENGINE_EVAL_FIELDS})
        for evaluation in body["e"]
    ]
    annotations = {}
    for ply, row in enumerate(body["m"], start=1):
        note = dict(zip(_ANALYSIS_FIELDS, row))
        for key in ("engine_eval_before", "engine_eval_after", "best_move_eval"):
            note[key] = evals[note[key]] if note[key] is not None else None
        annotations[ply] = note
    return rebuild_moves(body["i"], [note["uci"] for note in annotations.values()], annotations)


def move_signature(initial_fen: Optional[str], moves: Iterable[str]) -> str:
    """Identity signature for import dedupe: starting position + UCI sequence.

    The initial FEN is part of the signature on purpose: two games sharing a move
    sequence but starting from different positions (FEN-tagged set-ups, Chess960)
    are different games and must never dedupe against each other. The FEN is
    canonicalised so equivalent spellings of one starting position still match.
    """
    fen = canonicalize_fen(initial_fen) if initial_fen else STARTING_FEN
    return "{0}|{1}".format(fen, encode_uci_sequence(moves))


def move_needs_row(move: MoveRecord) -> bool:
    """True when a ply carries anything that cannot be rebuilt from UCI + FEN."""
    return bool(
        move.classification is not MoveClassification.UNKNOWN
        or move.comment
        or move.generated_comment
        or move.tags
        or move.engine_eval_before is not None
        or move.engine_eval_after is not None
        or move.best_move_eval is not None
        or move.best_move_uci
        or move.source not in (MoveSource.IMPORTED_PGN, MoveSource.LICHESS_GAME, MoveSource.HUMAN_GAME)
    )


def export_pgn(game: Game) -> str:
    """Keep the imported tree, overlaying authoritative mainline annotations."""
    board = chess.Board(game.initial_fen)
    pgn_game = chess.pgn.read_game(io.StringIO(game.pgn)) if game.pgn else None
    if (pgn_game is None or pgn_game.board().fen() != board.fen() or
            [move.uci() for move in pgn_game.mainline_moves()][:len(game.moves)] !=
            [record.uci for record in game.moves]):
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
    for record in game.moves:
        move = chess.Move.from_uci(record.uci)
        node = node.variations[0] if node.variations else node.add_variation(move)
        # Export original + current generated explanation (display merge), so a
        # PGN always carries what the UI shows.
        display = "\n".join(
            part for part in (record.comment, record.generated_comment) if part
        )
        node.comment = display
    return pgn_game.accept(chess.pgn.StringExporter(headers=True, variations=True, comments=True))


def _link_root(
    root_fen: str,
    nodes: Dict[str, OpeningNode],
    arriving_uci: Mapping[str, Optional[str]],
) -> Tuple[Optional[OpeningNode], Dict[Optional[str], List[OpeningNode]], Optional[chess.Board]]:
    """The root (with its position, side and synthetic arriving move), the
    parent -> children index, and a board parked at the root position.

    The root row can carry its own arriving move (a repertoire rooted at its first
    move). Only that UCI is stored, not the position before it, so the record is
    minimal. SYNTHETIC-METADATA CONTRACT (do not widen): only ``uci``, ``ply``
    (half-moves elapsed at the root) and ``side_to_move`` (the opposite of the
    root's own) are trustworthy, and every path-based consumer (training,
    scheduler, matching, progress) reads exactly these. ``move_number`` is the
    root FEN's fullmove field (one high for black roots), ``san`` mirrors the UCI
    and both FENs echo the root's own: display filler that must never feed board
    or PGN reconstruction. Dropping the move would make the repertoire appear to
    start one ply later than it does.
    """
    children: Dict[Optional[str], List[OpeningNode]] = {}
    for node in nodes.values():
        children.setdefault(node.parent_id, []).append(node)
    root = next((n for n in nodes.values() if n.parent_id is None), None)
    if root is None:
        return None, children, None
    board = chess.Board(canonicalize_fen(root_fen))
    root.fen = board.fen()
    root.side_to_move = _color_from_board(board)
    root_uci = arriving_uci.get(root.id)
    if root_uci:
        root.move = MoveRecord(
            uci=root_uci,
            san=root_uci,
            fen_before=root.fen,
            fen_after=root.fen,
            move_number=board.fullmove_number,
            ply=board.ply(),
            side_to_move=root.side_to_move.opponent,
            source=root.source,
        )
    root.children = []
    return root, children, board


def _arriving(arriving_uci: Mapping[str, Optional[str]], node: OpeningNode) -> str:
    uci = arriving_uci.get(node.id)
    if not uci:
        raise ValueError("opening node {0} is missing arriving UCI".format(node.id))
    return uci


def shape_opening_tree(
    root_fen: str,
    nodes: Dict[str, OpeningNode],
    arriving_uci: Mapping[str, Optional[str]],
) -> Optional[OpeningNode]:
    """Link an opening tree and derive structural move facts without SAN/FEN replay.

    Training's queue planner needs each move's UCI, mover side and ply, plus the
    tree's parent/child shape. Those follow from the root FEN and depth alone;
    the exact SAN/FEN pair is filled only for paths a response ships, by
    :func:`hydrate_opening_paths`. Until then ``fen_before``/``fen_after`` are
    empty and ``san`` is the UCI placeholder (the same synthetic-record contract
    as a root that carries its own arriving move).
    """
    root, children, board = _link_root(root_fen, nodes, arriving_uci)
    if root is None:
        return None
    root_turn = root.side_to_move
    root_ply = board.ply()

    def walk(node: OpeningNode, depth: int) -> None:
        for child in children.get(node.id, []):
            uci = _arriving(arriving_uci, child)
            ply = root_ply + depth + 1
            mover = root_turn if (depth + 1) % 2 == 1 else root_turn.opponent
            record = MoveRecord(
                uci=uci,
                san=uci,
                fen_before="",
                fen_after="",
                move_number=(ply + 1) // 2,
                ply=ply,
                side_to_move=mover,
                source=child.source,
            )
            if child.engine_evaluation is not None:
                record.engine_eval_after = child.engine_evaluation
            child.move = record
            child.fen = ""
            child.side_to_move = mover.opponent
            node.children.append(child)
            walk(child, depth + 1)

    walk(root, 0)
    walk = None  # break the closure's self-reference (see hydrate_opening_tree)
    return root


def hydrate_opening_paths(root: OpeningNode, node_ids: Iterable[str]) -> None:
    """Fill exact SAN/FEN data on the paths to ``node_ids`` (and their ancestors).

    A structurally shaped tree replays only the branches a training response
    serves. Extra ids beyond a card's last target — immediate replies and sibling
    alternatives — hydrate as single nodes without pulling their whole subtrees in.
    Already hydrated nodes are reused, so overlapping cards pay their shared prefix
    once per loaded tree.
    """
    wanted = set(node_ids)
    if not wanted:
        return
    nodes: Dict[str, OpeningNode] = {}
    stack = [root]
    while stack:
        node = stack.pop()
        nodes[node.id] = node
        stack.extend(node.children)

    keep = set()
    for node_id in wanted:
        current = nodes.get(node_id)
        while current is not None and current.id != root.id and current.id not in keep:
            keep.add(current.id)
            current = nodes.get(current.parent_id) if current.parent_id else None
    if not keep:
        return

    board = chess.Board(root.fen)

    def walk(node: OpeningNode, fen: str) -> None:
        # ``board`` is parked at ``fen`` on entry, exactly as in hydrate_opening_tree.
        for child in node.children:
            if child.id not in keep:
                continue
            move = child.move
            if move is None or not move.uci:
                raise ValueError("opening node {0} is missing arriving UCI".format(child.id))
            if move.fen_after:
                board.push(chess.Move.from_uci(move.uci))
            else:
                record = _replay_on_board(board, move.uci, source=child.source, fen_before=fen)
                if child.engine_evaluation is not None:
                    record.engine_eval_after = child.engine_evaluation
                child.move = record
                child.fen = record.fen_after
                child.side_to_move = _color_from_board(board)
            walk(child, child.move.fen_after)
            board.pop()

    walk(root, root.fen)
    walk = None


def hydrate_opening_tree(
    root_fen: str,
    nodes: Dict[str, OpeningNode],
    arriving_uci: Mapping[str, Optional[str]],
) -> Optional[OpeningNode]:
    """Fill fen / side / move on opening nodes by walking parent → arriving UCI."""
    root, children, board = _link_root(root_fen, nodes, arriving_uci)
    if root is None:
        return None

    def walk(node: OpeningNode, fen: str) -> None:
        # Children replay from the parent's real FEN, so their records are fully
        # hydrated. ``board`` is parked at ``fen`` (the parent's serialized
        # ``fen_after``) on entry: each child is one push and one pop, so no
        # position is re-parsed or serialized twice.
        for child in children.get(node.id, []):
            record = _replay_on_board(
                board, _arriving(arriving_uci, child), source=child.source, fen_before=fen
            )
            if child.engine_evaluation is not None:
                record.engine_eval_after = child.engine_evaluation
            child.move = record
            child.fen = record.fen_after
            child.side_to_move = _color_from_board(board)
            node.children.append(child)
            walk(child, record.fen_after)
            board.pop()

    walk(root, root.fen)
    # The recursive closure captures every node via ``children``. Break its
    # self-reference so released trees do not wait for cyclic GC to be freed.
    walk = None
    return root
