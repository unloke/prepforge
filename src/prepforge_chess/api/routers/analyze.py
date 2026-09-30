"""Analyze endpoints — the browser-compute analysis flow.

The Analyze view runs Stockfish (and optionally Maia) **in the browser**; the server
only orchestrates and persists, never computing chess. Two POSTs carry the flow:

* ``/api/analyze/prepare`` imports a PGN (owner-scoped) and returns every position
  the browser must evaluate, plus a move skeleton.
* ``/api/analyze/classify-save`` takes the browser's per-position evals (and optional
  Maia move assessments for Brilliant detection), replays them through the unchanged
  ``AnalysisService`` (via :class:`ReplayEngine` / :class:`ReplayMaia`), and persists
  the classified game.

Two GETs read it back: ``/api/analyses`` (history list) and ``/api/analyses/{id}``
(recall the latest saved analysis). ``/api/board`` is a pure utility (legal moves +
status for a FEN).
"""
from __future__ import annotations

import math
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from prepforge_chess.api.deps import current_owner, current_user, get_repository
from prepforge_chess.api.ratelimit import limiter
from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import MoveSource
from prepforge_chess.services.analysis_view import analysis_result_to_payload
from prepforge_chess.services.app_settings import owner_maia_rating, owner_stockfish_depth
from prepforge_chess.services.brilliant import BrilliantAnalyzer, BrilliantConfig
from prepforge_chess.services.browser_compute import (
    PositionPayloadError,
    classify_precomputed_game,
    validate_position_payload,
)
from prepforge_chess.services.pgn_import import PgnImportOptions, PgnImportService
from prepforge_chess.services.replay_engine import ReplayEngineError
from prepforge_chess.services.replay_maia import ReplayMaia
from prepforge_chess.storage.repositories import PrepForgeRepository

router = APIRouter(prefix="/api", tags=["analyze"])

# ChessCore wraps python-chess and holds no per-request state, so one shared
# instance serves the stateless /api/board utility.
_CHESS = ChessCore()
MAX_ANALYSIS_PGN_CHARS = 1_000_000
MAX_ANALYSIS_POSITIONS = 1_000


MAX_ANALYSIS_IMPORT_GAMES = 20


def _import_pgn_for_analysis(
    repo: PrepForgeRepository,
    pgn_text: str,
    owner: str,
    *,
    mode: str = "single",
    select_index: int = 0,
) -> tuple[str, dict[str, Any]]:
    """Import the pasted PGN with explicit multi-game semantics (F-04).

    Parse FIRST, store after — so single mode can reject a multi-game paste
    before anything lands. Each game reports its own outcome (imported /
    already present / failed), a partial success is never dressed up as total
    failure, and the game actually selected for analysis is always named.
    Raises ValueError (→ 400) with a readable message otherwise.
    """
    if not pgn_text.strip():
        raise ValueError("PGN text is empty")
    service = PgnImportService(repo)
    parsed = service.parse_text(pgn_text)
    total = len(parsed)
    if total == 0:
        raise ValueError("No PGN games found.")
    if total > MAX_ANALYSIS_IMPORT_GAMES:
        raise ValueError(
            "Too many games in one paste ({0}; max {1}).".format(
                total, MAX_ANALYSIS_IMPORT_GAMES
            )
        )
    if mode == "single" and total != 1:
        # Validated BEFORE storing anything: no silent import of the extras.
        raise ValueError(
            "Found {0} games in the PGN — this flow analyzes one game at a time. "
            "Remove the extra games, or use multi-game mode.".format(total)
        )
    statuses = service.import_parsed(
        parsed, PgnImportOptions(skip_duplicate_lichess_games=True), owner_user_id=owner
    )
    games_summary = [
        {
            "index": s.index,
            "game_id": s.game_id,
            "status": s.status,
            "white": s.white,
            "black": s.black,
            "error": s.error,
        }
        for s in statuses
    ]
    if mode == "single":
        selected = statuses[0]
    else:
        if select_index < 0 or select_index >= len(statuses):
            raise ValueError(
                "select_index {0} is out of range ({1} games).".format(
                    select_index, len(statuses)
                )
            )
        selected = statuses[select_index]
    if selected.status == "failed" or not selected.game_id:
        raise ValueError(
            "Game {0} could not be imported: {1}".format(
                selected.index + 1, selected.error or "no game id"
            )
        )
    imported = [s.game_id for s in statuses if s.status == "imported" and s.game_id]
    existing = [s.game_id for s in statuses if s.status == "existing" and s.game_id]
    failed = [s for s in statuses if s.status == "failed"]
    import_summary = {
        "mode": mode,
        "total_games": total,
        "imported_count": len(imported),
        "existing_count": len(existing),
        "failed_count": len(failed),
        "selected_index": selected.index,
        "selected_game_id": selected.game_id,
        "games": games_summary,
    }
    return selected.game_id, import_summary


def _brilliant_analyzer_from_client(
    maia_assessments: list[dict[str, Any]] | None,
) -> BrilliantAnalyzer | None:
    """Build a BrilliantAnalyzer over browser-supplied Maia move assessments, or None.

    Validates the untrusted payload: each item needs a FEN + UCI string and finite
    ``human_probability`` / ``win_chance_after`` in [0, 1], plus an OPTIONAL finite
    ``trap_gap`` in [-1, 1] (the browser-computed trap layer). A malformed item raises
    ValueError (→ 400). Empty/omitted → None (no Brilliant detection — the browser
    has no Maia)."""
    if not maia_assessments:
        return None
    if not isinstance(maia_assessments, list):
        raise ValueError("maia_assessments must be a list")
    # Cap to bound the untrusted payload (one assessment per ply; a long game is well
    # under this — same spirit as the apply-plan change cap).
    if len(maia_assessments) > 1000:
        raise ValueError("too many maia_assessments (max 1000)")
    cleaned: list[dict[str, Any]] = []
    for item in maia_assessments:
        if not isinstance(item, dict):
            raise ValueError("each maia_assessment must be an object")
        fen = item.get("fen")
        uci = item.get("uci")
        if not fen or not isinstance(fen, str):
            raise ValueError("each maia_assessment requires a fen string")
        if not uci or not isinstance(uci, str):
            raise ValueError("each maia_assessment requires a uci string")
        for key in ("human_probability", "win_chance_after"):
            value = item.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError("maia_assessment {0} must be a number".format(key))
            if not math.isfinite(value) or value < 0.0 or value > 1.0:
                raise ValueError("maia_assessment {0} must be in [0, 1]".format(key))
        # trap_gap is optional (only the browser's eligible/unintuitive moves carry one):
        # validate it when present, leave it absent otherwise. It is a difference of two
        # win chances, so it ranges over [-1, 1] rather than [0, 1].
        trap = item.get("trap_gap")
        if trap is not None:
            if not isinstance(trap, (int, float)) or isinstance(trap, bool):
                raise ValueError("maia_assessment trap_gap must be a number")
            if not math.isfinite(trap) or trap < -1.0 or trap > 1.0:
                raise ValueError("maia_assessment trap_gap must be in [-1, 1]")
        cleaned.append(item)
    # No engine is wired here (Stockfish + Maia3 run in the browser), so the trap layer's
    # extra eval can't run server-side. Instead the browser computes each eligible move's
    # trap_gap locally and ships it in the assessment; ReplayMaia replays it
    # (precomputed_trap_gap) and BrilliantAnalyzer uses that value, so the public flow
    # flags brilliancies with zero server compute. A move with no trap_gap (the browser
    # had no Maia, or the move wasn't unintuitive) simply isn't flagged.
    return BrilliantAnalyzer(maia=ReplayMaia(cleaned))


# ---- Browser-compute flow --------------------------------------------------


class PreparePayload(BaseModel):
    pgn: str = Field(default="", max_length=MAX_ANALYSIS_PGN_CHARS)
    # F-04: "single" (default) rejects multi-game pastes BEFORE storing any of
    # them; "multi" imports every game with per-game status and analyzes the
    # one named by ``select_index``.
    mode: Literal["single", "multi"] = "single"
    select_index: int = Field(default=0, ge=0, le=MAX_ANALYSIS_IMPORT_GAMES)


@router.post("/analyze/prepare")
@limiter.limit("10/minute")
def analyze_prepare(
    request: Request,
    body: PreparePayload,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Import a PGN and return the positions the browser must evaluate.

    ``positions`` is every distinct ``fen_before`` plus the final ``fen_after`` — the
    complete set the classifier needs, since ``fen_after(N) == fen_before(N+1)``.
    ``import_summary`` names every stored/failed game and which one is analyzed."""
    try:
        game_id, import_summary = _import_pgn_for_analysis(
            repo, body.pgn, owner, mode=body.mode, select_index=body.select_index
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    # The freshly-imported game is unowned; claim it for the caller.
    repo.claim_or_verify_game(game_id, owner)
    game = repo.load_game(game_id)
    if game is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="game not found after import: {0}".format(game_id),
        )

    positions: list[str] = []
    seen: set[str] = set()

    def _add(fen: str) -> None:
        if fen and fen not in seen:
            seen.add(fen)
            positions.append(fen)

    moves_skeleton: list[dict[str, Any]] = []
    for move in game.moves:
        _add(move.fen_before)
        moves_skeleton.append(
            {
                "ply": move.ply,
                "move_number": move.move_number,
                "side": move.side_to_move.value,
                "san": move.san,
                "uci": move.uci,
                "fen_before": move.fen_before,
                "fen_after": move.fen_after,
            }
        )
    if game.moves:
        _add(game.moves[-1].fen_after)

    return {
        "game_id": game_id,
        "import_summary": import_summary,
        "engine": "stockfish (browser)",
        "depth": owner_stockfish_depth(repo, owner),
        "positions": positions,
        "moves": moves_skeleton,
        # Brilliant detection toggle. The Maia3 strength used for the move
        # assessments is resolved CLIENT-side (effectiveMaiaRating: Settings-pinned,
        # else AUTO from the linked Lichess account, else default) so the read is
        # personalized and matches the live coach. ``rating`` is echoed only as the
        # owner's pinned preference (null = AUTO); ReplayMaia ignores it server-side.
        "brilliant": {
            "enabled": BrilliantConfig().enabled,
            "rating": owner_maia_rating(repo, owner),
        },
    }


class ClassifySavePayload(BaseModel):
    game_id: str = ""
    engine: str = "stockfish (browser)"
    depth: int | None = None
    positions: list[dict[str, Any]] | None = Field(default=None, max_length=MAX_ANALYSIS_POSITIONS)
    maia_assessments: list[dict[str, Any]] | None = Field(
        default=None, max_length=MAX_ANALYSIS_POSITIONS
    )


@router.post("/analyze/classify-save")
@limiter.limit("10/minute")
def analyze_classify_save(
    request: Request,
    body: ClassifySavePayload,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Classify + persist a game from browser-computed per-position evals.

    Browser-compute fast path: the browser already ran Stockfish (per-position
    evals) and optionally Maia3 (move assessments), so the server only
    validates the payload, applies the precomputed evals, classifies each move
    once (``classify_move`` stays the single source of truth, via the shared
    ``classify_precomputed_game`` helper), persists with batched writes, and
    serializes. No engine or model compute runs here.

    Per-phase server timings ride back as ``server_timings_ms`` so the UI can
    show classifying vs saving honestly instead of one "classifying" label."""
    if not body.game_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="game_id is required")
    # Persisting analysis writes to the game; gate on ownership so a browser can't
    # classify-save into another profile's game by passing its id.
    timings_ms: dict[str, int] = {}
    mark = time.perf_counter()
    owned = repo.claim_or_verify_game(body.game_id, owner)
    timings_ms["ownership_ms"] = int((time.perf_counter() - mark) * 1000)
    if not owned:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="game not found")
    if not isinstance(body.positions, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="positions must be a list"
        )
    mark = time.perf_counter()
    # D-03: bounded typed contract over the untrusted per-position payload.
    # A non-numeric score, malformed PV/UCI, out-of-range depth/nodes/mate, or
    # a non-object item is a readable 400 with the offending field — never a
    # 500, and always before any write (no partial saves).
    try:
        validated = validate_position_payload(body.positions)
    except PositionPayloadError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    position_map: dict[str, dict[str, Any]] = {}
    for item in validated:
        position_map[item["fen"]] = item
    if not position_map:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="positions are required"
        )
    timings_ms["validate_ms"] = int((time.perf_counter() - mark) * 1000)

    engine_name = (body.engine or "stockfish (browser)").strip() or "stockfish (browser)"
    resolved_depth = (
        int(body.depth)
        if body.depth is not None
        else owner_stockfish_depth(repo, owner)
    )
    resolved_depth = max(1, min(resolved_depth, 60))

    mark = time.perf_counter()
    try:
        brilliant_analyzer = _brilliant_analyzer_from_client(body.maia_assessments)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    timings_ms["maia_validate_ms"] = int((time.perf_counter() - mark) * 1000)

    mark = time.perf_counter()
    game = repo.load_game(body.game_id, owner_user_id=owner)
    timings_ms["load_game_ms"] = int((time.perf_counter() - mark) * 1000)
    if game is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="game not found")

    mark = time.perf_counter()
    try:
        result = classify_precomputed_game(
            game,
            position_map,
            engine_name=engine_name,
            depth=resolved_depth,
            brilliant_analyzer=brilliant_analyzer,
            maia_rating=owner_maia_rating(repo, owner),
        )
    except ReplayEngineError as exc:
        # Incomplete client payload (a position was never evaluated).
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except PositionPayloadError as exc:
        # Conflicting duplicate evaluations and other payload faults: same
        # readable-4xx contract (D-03).
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    timings_ms["classify_ms"] = int((time.perf_counter() - mark) * 1000)

    mark = time.perf_counter()
    repo.save_game_batched(game, result, owner_user_id=owner)
    timings_ms["save_game_ms"] = int((time.perf_counter() - mark) * 1000)

    mark = time.perf_counter()
    repo.save_analysis_result(result)
    timings_ms["save_analysis_ms"] = int((time.perf_counter() - mark) * 1000)

    mark = time.perf_counter()
    payload = analysis_result_to_payload(result)
    timings_ms["serialize_ms"] = int((time.perf_counter() - mark) * 1000)
    payload["server_timings_ms"] = timings_ms
    return payload


# ---- History reads ---------------------------------------------------------


def _parse_cursor(cursor: str | None) -> tuple[str, str] | None:
    if not cursor:
        return None
    analyzed_at, sep, game_id = cursor.partition("|")
    if not sep or not analyzed_at or not game_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid cursor"
        )
    return analyzed_at, game_id


@router.get("/analyses")
def list_analyses(
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
    limit: int = 50,
    cursor: str | None = None,
) -> dict[str, Any]:
    """This owner's analyzed games (latest analysis per game, newest first).

    D-05: fixed page size with a stable keyset cursor — pass the returned
    ``next_cursor`` to fetch the next page (no gaps or repeats at equal
    timestamps). ``limit`` is clamped server-side (1–200)."""
    analyses, next_cursor = repo.list_analyzed_games(
        owner_user_id=owner, limit=limit, cursor=_parse_cursor(cursor)
    )
    return {
        "analyses": analyses,
        "next_cursor": (
            "{0}|{1}".format(*next_cursor) if next_cursor is not None else None
        ),
    }


@router.get("/analyses/{game_id}")
def recall_analysis(
    game_id: str,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Recall the latest saved analysis for one of this owner's games. A foreign or
    unanalyzed game is 404 (the owner-scoped load returns None either way)."""
    result = repo.load_latest_analysis_result(game_id, owner_user_id=owner)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="no saved analysis for that game"
        )
    return analysis_result_to_payload(result)


# ---- Board utility ---------------------------------------------------------


def _board_payload(fen: str) -> dict[str, Any]:
    """Legal moves + check/mate/stalemate status for a FEN. Raises ``ValueError`` /
    ``KeyError`` on a malformed FEN (callers translate to 400)."""
    position = _CHESS.position_from_fen(fen)
    st = _CHESS.status(fen)
    return {
        "fen": position.fen,
        "side_to_move": position.side_to_move.value,
        "legal_moves": position.legal_moves,
        "status": {
            "is_check": st.is_check,
            "is_checkmate": st.is_checkmate,
            "is_stalemate": st.is_stalemate,
        },
    }


@router.get("/board")
def board(
    fen: str,
    _user: Any = Depends(current_user),
) -> dict[str, Any]:
    """Legal moves + check/mate/stalemate status for a FEN. Pure chess utility (no
    owned data); auth-gated only because the whole app is behind login."""
    try:
        return _board_payload(fen)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


class BoardMoveBody(BaseModel):
    fen: str
    move_uci: str


@router.post("/board/move")
def board_move(
    body: BoardMoveBody,
    _user: Any = Depends(current_user),
) -> dict[str, Any]:
    """Apply one UCI move to a FEN and return the resulting move + board. Pure chess
    utility (the browser drives the board; this echoes python-chess's legality + SAN).
    No owned data, so it's auth-gated only. A malformed FEN or illegal move → 400."""
    try:
        move = _CHESS.apply_uci(body.fen, body.move_uci, source=MoveSource.MANUAL)
        board_after = _board_payload(move.fen_after)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {
        "move": {
            "uci": move.uci,
            "san": move.san,
            "fen_before": move.fen_before,
            "fen_after": move.fen_after,
            "move_number": move.move_number,
            "ply": move.ply,
            "side_to_move": move.side_to_move.value,
        },
        "board": board_after,
    }
