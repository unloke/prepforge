"""Smart + rehearsal Train endpoints — the spaced-repetition trainer.

``TrainingService`` walks the stored repertoire tree with python-chess (move legality
only); no Stockfish/Maia runs server-side. Ownership: ``/start`` gates the
repertoire through ``_owned_repertoire``; the session-keyed endpoints resolve
the session to its repertoire and reject another owner's session.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Any, Literal

import chess
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from prepforge_chess.api.deps import current_owner, get_repository
from prepforge_chess.api.routers.workspace import _owned_repertoire
from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import (
    Repertoire,
    TrainingMode,
    TrainingProgress,
    TrainingSession,
)
from prepforge_chess.services import streak
from prepforge_chess.services.progress import compute_health, due_forecast
from prepforge_chess.services.training import TrainingService, update_spaced_repetition
from prepforge_chess.services.training_smart import SmartTrainingService
from prepforge_chess.services.training_view import (
    heuristic_strategy,
    prompt_to_json,
    smart_prompt_to_json,
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
    and 404s when that repertoire belongs to a different user."""
    session = repo.load_training_session(session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="training session not found"
        )
    meta = repo.repertoire_meta(session.repertoire_id)
    if meta is None or meta["owner_user_id"] != owner:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="training session not found"
        )
    return session


class StartBody(BaseModel):
    repertoire_id: str
    mode: Literal["all_lines", "high_priority", "mistakes_only", "smart"] | None = None
    seed: int = 13
    fresh: bool = False


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
    # The ownership gate above permits loading the repertoire by id here.
    repertoire = repo.load_repertoire(body.repertoire_id)
    if repertoire is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    service = TrainingService(repo, owner)
    session = service.start_or_resume_session(
        repertoire.id, mode=mode, seed=body.seed, fresh=body.fresh
    )
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
        "resumed": (not body.fresh) and session.current_index > 0,
    }


class SessionBody(BaseModel):
    session_id: str


class RecordMissBody(BaseModel):
    repertoire_id: str
    node_id: str


@router.post("/record-miss")
def record_miss(
    body: RecordMissBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Record a single recall miss on a repertoire node — the Analyze board's
    "you left your prep here" action: one spaced-repetition miss, due
    immediately, so the forgotten move leads the very next smart session."""
    _owned_repertoire(repo, body.repertoire_id, owner)
    repertoire = repo.load_repertoire(body.repertoire_id)
    if repertoire is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    node = next(
        (n for n in walk_opening_nodes(repertoire.root_node) if n.id == body.node_id),
        None,
    )
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="opening node not found")
    progress = repo.load_training_progress(
        body.repertoire_id, body.node_id, owner_user_id=owner
    ) or TrainingProgress(node_id=body.node_id)
    updated = update_spaced_repetition(progress, correct=False)
    # An in-session miss retries after 10 minutes; a miss spotted on the Analyze
    # board should land in the very next session, so it is due immediately.
    updated = replace(updated, due_at=updated.last_reviewed_at)
    repo.save_training_progress(body.repertoire_id, updated, owner_user_id=owner)
    return {"recorded": True, "node_id": body.node_id}


# ----- Smart queue (Train v2): card-based scheduler endpoints ----------------


class SmartStartBody(BaseModel):
    # mixed=True trains ALL active repertoires in one interleaved queue and
    # ignores repertoire_id; otherwise repertoire_id is required.
    repertoire_id: str | None = None
    mixed: bool = False
    fresh: bool = False
    session_size: int | None = None
    new_cap: int | None = None
    seed: int | None = None  # deterministic queues for tests


class SmartMoveBody(BaseModel):
    session_id: str
    played_uci: str
    # 1 = first (graded) answer; 2+ = retry / play-after-reveal, never graded.
    attempt: int = 1
    # The player's local calendar date (YYYY-MM-DD) for the daily streak; the
    # server clamps it and falls back to UTC today (see services/streak.py).
    local_date: str | None = None


def _clamp(value: int | None, low: int, high: int) -> int | None:
    return None if value is None else max(low, min(high, value))


def _touch_streak(
    repo: PrepForgeRepository, owner: str, local_date: str | None
) -> dict[str, Any]:
    """Mark "trained today" on the owner's daily streak and return the view the
    client renders. Called from the graded move endpoints — submitting any move
    is what counts as training, so one call per day actually changes state and
    the rest no-op (skipping the settings write).

    The read->advance->write is one atomic mutation (row-locked) so a concurrent
    settings write -- e.g. the dashboard's weekly recap snapshot -- can't read
    the pre-advance blob and clobber the streak back to yesterday (lost update)."""
    day = streak.resolve_day(local_date)
    advanced = repo.mutate_user_setting(
        owner, streak.STREAK_KEY, lambda stored: streak.advance(stored, day)
    )
    return streak.as_view(advanced, day)


def _smart_summary_payload(
    repo: PrepForgeRepository, repertoire: Repertoire, owner: str
) -> dict[str, Any]:
    """Repertoire health + tomorrow's due forecast — the smart session's
    bookends. Shipped with ``/smart/start`` (the before snapshot) and from
    ``/smart/summary`` (the after, for the end-of-session mastery delta)."""
    progress_by_id = {
        p.node_id: p for p in repo.list_training_progress(repertoire.id, owner_user_id=owner)
    }
    health = compute_health(
        repertoire.root_node, repertoire.color, progress_by_id
    ).to_dict()
    # Keep the dashboard's cached badge in step with post-session mastery gains.
    repo.set_repertoire_health(repertoire.id, health)
    return {
        "health": health,
        "due_tomorrow": due_forecast(
            repertoire.root_node, repertoire.color, progress_by_id
        ),
    }


def _mixed_summary_payload(
    repo: PrepForgeRepository, reps: list[Repertoire], owner: str
) -> dict[str, Any]:
    """The mixed-session bookend: per-repertoire health summed into one view
    (mastery_pct recomputed over the combined trainable count)."""
    health: dict[str, int] = {}
    due_tomorrow = 0
    for rep in reps:
        part = _smart_summary_payload(repo, rep, owner)
        for key, value in part["health"].items():
            health[key] = health.get(key, 0) + value
        due_tomorrow += part["due_tomorrow"]
    trainable = health.get("trainable", 0)
    health["mastery_pct"] = (
        round(health.get("mastered", 0) / trainable * 100) if trainable else 0
    )
    return {"health": health, "due_tomorrow": due_tomorrow}


@router.post("/smart/start")
def smart_start(
    body: SmartStartBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Begin (or resume) a card-queue session and return the queue composition
    plus the first card prompt. ``mixed=True`` builds one interleaved queue
    over ALL of the caller's active repertoires."""
    service = SmartTrainingService(repo, owner)
    try:
        if body.mixed:
            session = service.start_or_resume_mixed(
                owner,
                fresh=body.fresh,
                session_size=_clamp(body.session_size, 4, 30),
                new_cap=_clamp(body.new_cap, 0, 10),
                seed=body.seed,
            )
        else:
            if not body.repertoire_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="repertoire_id is required unless mixed=true",
                )
            _owned_repertoire(repo, body.repertoire_id, owner)
            session = service.start_or_resume(
                body.repertoire_id,
                fresh=body.fresh,
                session_size=_clamp(body.session_size, 4, 30),
                new_cap=_clamp(body.new_cap, 0, 10),
                seed=body.seed,
            )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    # The session anchors on a real repertoire either way (mixed sessions pick
    # a stable anchor); reuse the tree the service already loaded while building
    # the session (cached per request) rather than reading it from the DB again.
    repertoire = service.repertoire(session.repertoire_id)
    if repertoire is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    prompt = service.current_prompt(session.id)
    if prompt is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="repertoire has no trainable moves yet",
        )
    summary = (
        _mixed_summary_payload(repo, service.active_repertoires(owner), owner)
        if body.mixed
        else _smart_summary_payload(repo, repertoire, owner)
    )
    return {
        "repertoire_id": repertoire.id,
        "repertoire_name": "All repertoires" if body.mixed else repertoire.name,
        "color": repertoire.color.value,
        "mixed": body.mixed,
        "session_id": session.id,
        "seed": session.seed,
        "mode": TrainingMode.SMART.value,
        "total_cards": len(session.line_order),
        "card_index": session.current_index,
        "resumed": (not body.fresh) and session.current_index > 0,
        "counts": service.counts(session),
        "prompt": smart_prompt_to_json(prompt, _CHESS),
        # The full queue, expanded per target (expected move, run-in, hint,
        # reply): the client runs the whole session locally off this bundle and
        # only syncs graded attempts back in batches (/smart/sync).
        "cards": service.session_card_bundle(session, repertoire),
        # Pre-session health snapshot: the client diffs it against
        # /smart/summary at the end to show what the session changed.
        **summary,
    }


@router.get("/smart/summary")
def smart_summary(
    repertoire_id: str | None = None,
    mixed: bool = False,
    local_date: str | None = None,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Fresh health + tomorrow's due forecast for the end-of-session screen.
    ``mixed=true`` aggregates over all the caller's active repertoires.

    Carries the authoritative ``day_streak`` so the summary screen renders the
    server's truth rather than a possibly-stale client cache: the final sync
    before this fetch usually writes no new attempts, so ``/smart/sync`` returns
    ``day_streak: null`` and never refreshes the client value."""
    if mixed:
        payload = _mixed_summary_payload(
            repo, SmartTrainingService(repo, owner).active_repertoires(owner), owner
        )
    elif not repertoire_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="repertoire_id is required unless mixed=true",
        )
    else:
        _owned_repertoire(repo, repertoire_id, owner)
        repertoire = repo.load_repertoire(repertoire_id)
        if repertoire is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
        payload = _smart_summary_payload(repo, repertoire, owner)
    day = streak.resolve_day(local_date)
    payload["day_streak"] = streak.as_view(
        repo.get_user_setting(owner, streak.STREAK_KEY), day
    )
    return payload


@router.post("/smart/move")
def smart_move(
    body: SmartMoveBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Grade the player's move against the current card. Only ``attempt`` 1
    writes spaced-repetition progress; a second wrong attempt re-queues the
    card later in the same session."""
    _owned_session(repo, body.session_id, owner)
    try:
        result = SmartTrainingService(repo, owner).submit_move(
            body.session_id, body.played_uci, attempt=max(1, body.attempt)
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {
        "correct": result.correct,
        "attempt": result.attempt,
        "sr_written": result.sr_written,
        "day_streak": _touch_streak(repo, owner, body.local_date),
        "played_uci": result.played_uci,
        "expected_uci": result.expected_uci,
        "expected_san": result.expected_san,
        "card_completed": result.card_completed,
        "session_completed": result.session_completed,
        "requeued": result.requeued,
        "total_cards": len(result.session.line_order),
        "card_index": result.session.current_index,
        "mistakes": result.session.mistakes,
        "progress": None
        if result.progress is None
        else {
            "node_id": result.progress.node_id,
            "attempts": result.progress.attempts,
            "correct_attempts": result.progress.correct_attempts,
            "spaced_repetition_score": result.progress.spaced_repetition_score,
            "is_mastered": result.progress.is_mastered,
        },
        "prompt": smart_prompt_to_json(result.next_prompt, _CHESS),
        "played_san": result.played_san,
        "fen_after_player": result.fen_after_player,
        "reply_uci": result.reply_uci,
        "reply_san": result.reply_san,
        "fen_after_reply": result.fen_after_reply,
    }


class SmartSyncAttempt(BaseModel):
    node_id: str
    correct: bool
    # Client-minted idempotency key, reused across retries of the same attempt.
    attempt_uuid: str = Field(min_length=1, max_length=64)


class SmartSyncBody(BaseModel):
    session_id: str
    # Graded FIRST attempts only, in play order — retries are never graded, so
    # the client doesn't send them. Replayed through record_attempt server-side.
    attempts: list[SmartSyncAttempt] = []
    # Where the local session stands, so an interrupted session resumes sanely.
    card_index: int | None = None
    queue: list[str] | None = None  # encoded cards incl. local requeues
    local_date: str | None = None


@router.post("/smart/sync")
def smart_sync(
    body: SmartSyncBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Persist a batch of locally graded attempts plus the session position —
    the local-first Train flush (replaces per-move ``/smart/move`` calls).
    Exactly-once per ``(session_id, attempt_uuid)``: retries reuse the UUID,
    identical redeliveries no-op, and UUID collisions with different payloads
    are rejected. Touches the daily streak once per batch that graded
    something NEW (duplicate retries never re-touch it)."""
    _owned_session(repo, body.session_id, owner)
    try:
        written = SmartTrainingService(repo, owner).sync_progress(
            body.session_id,
            [a.model_dump() for a in body.attempts],
            card_index=body.card_index,
            queue=body.queue,
            owner_user_id=owner,
        )
    except ValueError as exc:
        detail = str(exc)
        code = status.HTTP_409_CONFLICT if "different payload" in detail else status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=code, detail=detail) from exc
    return {
        "synced": written,
        "day_streak": _touch_streak(repo, owner, body.local_date) if written else None,
    }


@router.post("/smart/skip")
def smart_skip(
    body: SessionBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Skip the current card; return the next prompt (or ``None`` at the end)."""
    _owned_session(repo, body.session_id, owner)
    prompt = SmartTrainingService(repo, owner).skip_card(body.session_id)
    return {"prompt": smart_prompt_to_json(prompt, _CHESS)}


@router.post("/skip")
def skip(
    body: SessionBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Skip the current line; return the next prompt (or ``None`` at the end)."""
    _owned_session(repo, body.session_id, owner)
    prompt = TrainingService(repo, owner).skip_current_line(body.session_id)
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
    prompt = TrainingService(repo, owner).current_prompt(body.session_id)
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
    # Same daily-streak day hint as SmartMoveBody — rehearsal counts as training.
    local_date: str | None = None


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
        result = TrainingService(repo, owner).submit_move(body.session_id, body.played_uci)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {
        "correct": result.correct,
        "played_uci": result.played_uci,
        "expected_uci": result.expected_uci,
        "expected_san": result.expected_san,
        "completed_line": result.completed_line,
        "day_streak": _touch_streak(repo, owner, body.local_date),
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
