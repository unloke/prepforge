"""Ported Train endpoints (Phase 2b-2d-v) — the spaced-repetition trainer.

``TrainingService`` walks the stored repertoire tree with python-chess (move legality
only); no Stockfish/Maia runs server-side, so the whole Train surface already fits the
browser-compute model — these are a straight port, not a rewrite. They replace the
legacy server's ``/api/train/{start,move,skip,hint}``.

The unauthenticated demo (``/api/train/demo/start``) is deliberately **dropped**
(mirrors the dropped ``/api/analyze/demo``): the SaaS model is account-centric and a
shared, ownerless demo repertoire has no clean home in the multi-tenant DB.

Ownership: ``/start`` gates the repertoire through ``_owned_repertoire``; the
session-keyed endpoints resolve the session to its repertoire and reject another
owner's session (``_owned_session``, mirroring the legacy ``_assert_session_owner``).
"""
from __future__ import annotations

from typing import Any

import chess
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from prepforge_chess.api.deps import current_owner, get_repository
from prepforge_chess.api.routers.workspace import _owned_repertoire
from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import TrainingMode, TrainingSession
from prepforge_chess.services.training import TrainingService
from prepforge_chess.services.training_view import (
    heuristic_strategy,
    prompt_to_json,
    training_line_to_json,
    walk_opening_nodes,
)
from prepforge_chess.storage.repositories import PrepForgeRepository

router = APIRouter(prefix="/api/train", tags=["train"])

# ChessCore wraps python-chess and holds no per-request state, so one shared instance
# serves the prompts' legal-move lists.
_CHESS = ChessCore()


def _mode_or_400(raw: str | None) -> TrainingMode:
    try:
        return TrainingMode(raw) if raw is not None else TrainingMode.ALL_LINES
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid training mode"
        ) from exc


def _owned_session(
    repo: PrepForgeRepository, session_id: str, owner: str
) -> TrainingSession:
    """Owner gate for session-keyed endpoints. Resolves the session to its repertoire
    and 404s when that repertoire belongs to a different user (don't reveal another
    owner's session). Unclaimed/legacy rows (NULL owner) are allowed, mirroring the
    legacy ``_assert_session_owner``."""
    session = repo.load_training_session(session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="training session not found"
        )
    meta = repo.repertoire_meta(session.repertoire_id)
    if meta is not None and meta["owner_user_id"] not in (None, owner):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="training session not found"
        )
    return session


class StartBody(BaseModel):
    repertoire_id: str
    mode: str | None = None
    seed: int = 13


@router.post("/start")
def start(
    body: StartBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Begin (or resume) a trainer session over the owner's repertoire and return the
    first prompt plus the shuffled line plan."""
    _owned_repertoire(repo, body.repertoire_id, owner)
    mode = _mode_or_400(body.mode)
    # Gate already verified ownership (incl. unclaimed rows), so load without the
    # owner filter — matches the legacy start path.
    repertoire = repo.load_repertoire(body.repertoire_id)
    if repertoire is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    service = TrainingService(repo)
    session = service.start_or_resume_session(repertoire.id, mode=mode, seed=body.seed)
    prompt = service.current_prompt(session.id)
    if prompt is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="repertoire has no trainable lines yet",
        )
    return {
        "repertoire_id": repertoire.id,
        "repertoire_name": repertoire.name,
        "color": repertoire.color.value,
        "session_id": session.id,
        "seed": session.seed,
        "mode": mode.value,
        "line_order": session.line_order,
        "lines": [
            training_line_to_json(line) for line in service.training_lines(repertoire, mode)
        ],
        "prompt": prompt_to_json(prompt, _CHESS),
    }


class SessionBody(BaseModel):
    session_id: str


@router.post("/skip")
def skip(
    body: SessionBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Skip the current line; return the next prompt (or ``None`` at the end)."""
    _owned_session(repo, body.session_id, owner)
    prompt = TrainingService(repo).skip_current_line(body.session_id)
    return {"prompt": prompt_to_json(prompt, _CHESS)}


@router.post("/hint")
def hint(
    body: SessionBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Reveal the expected move for the current prompt, plus a short strategic nudge
    (the node's stored idea/plan/comment, else a piece-type heuristic)."""
    _owned_session(repo, body.session_id, owner)
    prompt = TrainingService(repo).current_prompt(body.session_id)
    if prompt is None:
        return {"expected_uci": None, "expected_san": None}

    uci = prompt.expected_move_uci
    san = prompt.expected_move_san
    piece_name: str | None = None
    try:
        board = chess.Board(prompt.fen_before)
        piece = board.piece_at(chess.parse_square(uci[:2]))
        if piece is not None:
            piece_name = chess.piece_name(piece.piece_type)
    except Exception:  # noqa: BLE001 - a malformed FEN just means no piece hint
        pass

    strategy: str | None = None
    repertoire = repo.load_repertoire(prompt.repertoire_id)
    if repertoire is not None:
        node = next(
            (
                n
                for n in walk_opening_nodes(repertoire.root_node)
                if n.id == prompt.expected_node_id
            ),
            None,
        )
        if node is not None:
            strategy = (
                node.strategic_idea or node.typical_plan or (node.comment or "")
            ).strip() or None
    if not strategy:
        strategy = heuristic_strategy(san, piece_name)

    return {
        "expected_uci": uci,
        "expected_san": san,
        "piece": "Move the {0}".format(piece_name) if piece_name else "Find the move",
        "strategy": strategy,
    }


class MoveBody(BaseModel):
    session_id: str
    played_uci: str


@router.post("/move")
def move(
    body: MoveBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Submit the player's move; grade it against the repertoire, persist progress, and
    return the result with the opponent's reply so the UI can animate both plies."""
    _owned_session(repo, body.session_id, owner)
    try:
        result = TrainingService(repo).submit_move(body.session_id, body.played_uci)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {
        "correct": result.correct,
        "played_uci": result.played_uci,
        "expected_uci": result.expected_uci,
        "expected_san": result.expected_san,
        "completed_line": result.completed_line,
        "mistakes": result.session.mistakes,
        "current_index": result.session.current_index,
        "progress": {
            "node_id": result.progress.node_id,
            "attempts": result.progress.attempts,
            "correct_attempts": result.progress.correct_attempts,
            "spaced_repetition_score": result.progress.spaced_repetition_score,
            "is_mastered": result.progress.is_mastered,
        },
        "prompt": prompt_to_json(result.next_prompt, _CHESS),
        "played_san": result.played_san,
        "fen_after_player": result.fen_after_player,
        "reply_uci": result.reply_uci,
        "reply_san": result.reply_san,
        "fen_after_reply": result.fen_after_reply,
    }
