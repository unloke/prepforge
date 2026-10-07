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
import base64
import zlib
from dataclasses import asdict
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
    :func:`encode_search_limit`-ed, PV in :func:`encode_pv` form), so a stored
    row can be re-fingerprinted bit-for-bit — this is what the migration
    backfill relies on. Therefore identical content hashes identically on
    write and on read-back, and any different result (different search or
    different numbers) hashes differently: evaluation rows become immutable
    snapshots that still dedupe (see the D-01 improvement review).
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
        fen_before = board.fen()
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
        fen_after=board.fen(),
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
        generated_meta = note.get("generated_meta")
        record.generated_meta = dict(generated_meta) if generated_meta else None
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


def encode_analysis_moves(moves: Sequence[MoveRecord]) -> str:
    """Self-contained run snapshot; never references mutable game annotations."""
    raw = json.dumps([asdict(move) for move in moves], separators=(",", ":")).encode("utf-8")
    return json.dumps({"codec": "zlib-base64-v1", "data": base64.b64encode(zlib.compress(raw)).decode("ascii")}, separators=(",", ":"))


def decode_analysis_moves(payload: Optional[str]) -> List[MoveRecord]:
    # Older analyses have no trustworthy per-run moves. Do not attach today's
    # shared annotations to a historical summary; reanalysis creates a snapshot.
    if payload is None:
        return []
    moves = []
    envelope = json.loads(payload)
    if envelope["codec"] != "zlib-base64-v1":
        raise ValueError("unsupported analysis snapshot codec")
    for row in json.loads(zlib.decompress(base64.b64decode(envelope["data"], validate=True))):
        row["side_to_move"] = Color(row["side_to_move"])
        row["source"] = MoveSource(row["source"])
        row["classification"] = MoveClassification(row["classification"])
        for key in ("engine_eval_before", "engine_eval_after", "best_move_eval"):
            if row.get(key) is not None:
                row[key] = EngineEvaluation(**row[key])
        moves.append(MoveRecord(**row))
    return moves


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
    if move.classification is not MoveClassification.UNKNOWN:
        return True
    if move.comment:
        return True
    if move.generated_comment:
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
    """Keep the imported tree, overlaying authoritative mainline annotations."""
    board = chess.Board(game.initial_fen)
    pgn_game = chess.pgn.read_game(io.StringIO(game.pgn)) if game.pgn else None
    if (pgn_game is None or pgn_game.board().fen() != board.fen() or
            [move.uci() for move in pgn_game.mainline_moves()] !=
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
    replay = chess.Board(game.initial_fen)
    for record in game.moves:
        move = chess.Move.from_uci(record.uci)
        node = node.variations[0] if node.variations else node.add_variation(move)
        # Export original + current generated explanation (display merge), so a
        # PGN always carries what the UI shows.
        display = "\n".join(
            part for part in (record.comment, record.generated_comment) if part
        )
        node.comment = display
        replay.push(move)
    return pgn_game.accept(chess.pgn.StringExporter(headers=True, variations=True, comments=True))



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
    # One board is created for the whole walk: replay_uci-style records are
    # produced with push/pop on the way down, instead of re-parsing a full FEN
    # per child (FEN parse/serialize dominated the old per-node replay).
    board = chess.Board(root.fen)
    root.side_to_move = _color_from_board(board)

    root_uci = arriving_uci.get(root.id)
    if root_uci:
        # The root row can carry its own arriving move (a repertoire rooted at
        # its first move). The stored rows keep only the UCI — the position that
        # precedes the root is not persisted — so rehydrate a minimal record:
        # the mover is the side to move AT the root's parent position (the
        # opposite of the root's own side to move), and the move's ply is the
        # number of half-moves already elapsed at the root. Dropping this move
        # would make the repertoire appear to start one ply later than it does.
        #
        # SYNTHETIC-METADATA CONTRACT (matches its consumers; do not widen):
        # only `uci`, `ply` (half-moves elapsed at the root) and `side_to_move`
        # are fully trustworthy — every path-based consumer (training,
        # scheduler, matching, progress) reads exactly these. `move_number` is
        # the root FEN's fullmove field: right for white roots, one high for
        # black roots — nothing consumes it (workspace filler + a FEN-first
        # fallback in the client only). `san` mirrors the UCI and
        # `fen_before`/`fen_after` both echo the root's own FEN because the
        # pre-root position is not persisted; these are display-only filler
        # (e.g. OpeningTreeItem/"root" rows) and must never feed board or PGN
        # reconstruction. Correct san/fens would need the parent position,
        # which the schema does not store. Known paths that receive the root
        # node and only touch these fields: match_game_to_repertoire
        # (uci/ply), opening_item_to_json (filler, depth-0-guarded in UI),
        # _move_to_dict/export helpers (filler), and mastery/health counting
        # (side_to_move via _is_trainable).
        root.move = MoveRecord(
            uci=root_uci,
            san=root_uci,
            fen_before=root.fen,
            fen_after=root.fen,
            move_number=board.fullmove_number,
            ply=board.ply(),
            side_to_move=_color_from_board(board).opponent,
            source=root.source,
        )

    def walk(node: OpeningNode, fen: str) -> None:
        # Child nodes replay from the parent's real FEN, so their MoveRecord is
        # fully hydrated — unlike the root's synthetic record above. ``board``
        # is parked at ``fen`` on entry: each child is reached by one push and
        # left by one pop, so no position is ever re-parsed from a FEN string.
        # ``fen`` is the already-serialized current position (the parent's
        # ``fen_after``), so ``fen_before`` needs no second serialization.
        for child in children.get(node.id, []):
            uci = arriving_uci.get(child.id)
            if not uci:
                raise ValueError("opening node {0} is missing arriving UCI".format(child.id))
            source = child.source
            record = _replay_on_board(board, uci, source=source, fen_before=fen)
            if child.engine_evaluation is not None:
                record.engine_eval_after = child.engine_evaluation
            child.move = record
            child.fen = record.fen_after
            child.side_to_move = _color_from_board(board)
            node.children.append(child)
            walk(child, record.fen_after)
            board.pop()

    root.children = []
    walk(root, root.fen)
    # The recursive closure captures every node via ``children``. Break its
    # self-reference so released trees do not wait for cyclic GC to be freed.
    walk = None
    return root
