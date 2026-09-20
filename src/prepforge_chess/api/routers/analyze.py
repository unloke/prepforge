"""Ported analyze endpoints (Phase 2b-2d-i) — the browser-compute analysis flow.

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
status for a FEN). The legacy server's *server-engine* variants (``/api/analyze/pgn``,
``/pgn/start``, ``/status``, ``/cancel``, ``/demo``, ``/api/jobs/active``) are
deliberately **not** ported — they require a server-side engine the SaaS deploy
doesn't run.
"""
from __future__ import annotations

import math
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from prepforge_chess.api.deps import current_owner, current_user, get_repository
from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import MoveSource
from prepforge_chess.services.analysis_view import analysis_result_to_payload
from prepforge_chess.services.app_settings import owner_maia_rating, owner_stockfish_depth
from prepforge_chess.services.brilliant import BrilliantAnalyzer, BrilliantConfig
from prepforge_chess.services.browser_compute import classify_precomputed_game
from prepforge_chess.services.pgn_import import PgnImportOptions, PgnImportService
from prepforge_chess.services.replay_engine import ReplayEngineError
from prepforge_chess.services.replay_maia import ReplayMaia
from prepforge_chess.storage.repositories import PrepForgeRepository

router = APIRouter(prefix="/api", tags=["analyze"])

# ChessCore wraps python-chess and holds no per-request state, so one shared
# instance serves the stateless /api/board utility.
_CHESS = ChessCore()


def _import_pgn_for_analysis(repo: PrepForgeRepository, pgn_text: str, owner: str) -> str:
    """Import a single game (owner-scoped, dedup against this owner only) and return
    its id. Raises ValueError (→ 400) on empty/invalid PGN."""
    if not pgn_text.strip():
        raise ValueError("PGN text is empty")
    result = PgnImportService(repo).import_text(
        pgn_text,
        PgnImportOptions(skip_duplicate_lichess_games=True),
        owner_user_id=owner,
    )
    if result.errors:
        raise ValueError("; ".join(result.errors))
    game_ids = result.imported_game_ids or result.skipped_game_ids
    if not game_ids:
        raise ValueError("No game imported.")
    return game_ids[0]


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
    pgn: str = ""


@router.post("/analyze/prepare")
def analyze_prepare(
    body: PreparePayload,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Import a PGN and return the positions the browser must evaluate.

    ``positions`` is every distinct ``fen_before`` plus the final ``fen_after`` — the
    complete set the classifier needs, since ``fen_after(N) == fen_before(N+1)``."""
    try:
        game_id = _import_pgn_for_analysis(repo, body.pgn, owner)
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
    positions: list[dict[str, Any]] | None = None
    maia_assessments: list[dict[str, Any]] | None = None


@router.post("/analyze/classify-save")
def analyze_classify_save(
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
    position_map: dict[str, dict[str, Any]] = {}
    for item in body.positions:
        if not isinstance(item, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="each position must be an object"
            )
        fen = item.get("fen")
        if not fen or not isinstance(fen, str):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="each position requires a fen string",
            )
        position_map[fen] = item
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
        )
    except ReplayEngineError as exc:
        # Incomplete client payload (a position was never evaluated).
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


@router.get("/analyses")
def list_analyses(
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """This owner's analyzed games (latest analysis per game, newest first)."""
    return {"analyses": repo.list_analyzed_games(owner_user_id=owner)}


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
