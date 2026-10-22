"""FSRS scheduling for Train: when a drilled move is next due.

Each progress row carries an FSRS memory state (stability, difficulty, state,
step, lapses); ``attempts`` is the review count. Answers map to ratings:
correct unaided = Good, correct after a hint = Hard, wrong = Again. There is
no Easy signal.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Optional

from fsrs import Card, Rating, Scheduler, State

from prepforge_chess.core.models import TrainingProgress
from prepforge_chess.core.sr_config import SR_CONFIG, STATE_NEW, STATE_RELEARNING, STATE_REVIEW

_STEP = (timedelta(minutes=SR_CONFIG.learning_step_minutes),)
SCHEDULER = Scheduler(
    desired_retention=SR_CONFIG.desired_retention,
    learning_steps=_STEP,
    relearning_steps=_STEP,
    enable_fuzzing=False,
)


def rating_for(correct: bool, *, hinted: bool = False) -> Rating:
    if not correct:
        return Rating.Again
    return Rating.Hard if hinted else Rating.Good


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    return value.astimezone(timezone.utc) if value is not None else None


def _card(progress: TrainingProgress) -> Card:
    if progress.state == STATE_NEW:
        return Card(card_id=0)
    return Card(
        card_id=0,
        state=State(progress.state),
        step=progress.step,
        stability=progress.stability,
        difficulty=progress.difficulty,
        due=_utc(progress.due_at),
        last_review=_utc(progress.last_reviewed_at),
    )


def review(progress: TrainingProgress, rating: Rating, *, now: Optional[datetime] = None) -> TrainingProgress:
    timestamp = _utc(now) or datetime.now(timezone.utc)
    card, _ = SCHEDULER.review_card(_card(progress), rating, review_datetime=timestamp)
    lapsed = rating == Rating.Again and progress.state == STATE_REVIEW
    return replace(
        progress,
        attempts=progress.attempts + 1,
        correct_attempts=progress.correct_attempts + (1 if rating >= Rating.Good else 0),
        last_reviewed_at=timestamp,
        due_at=card.due,
        state=card.state.value,
        step=card.step,
        stability=card.stability,
        difficulty=card.difficulty,
        lapses=progress.lapses + (1 if lapsed else 0),
    )


def retrievability(progress: Optional[TrainingProgress], *, now: Optional[datetime] = None) -> float:
    """Predicted recall odds now (0 for a move never reviewed)."""
    if progress is None or progress.state == STATE_NEW:
        return 0.0
    return float(SCHEDULER.get_card_retrievability(_card(progress), _utc(now) or datetime.now(timezone.utc)))


def is_weak(progress: TrainingProgress) -> bool:
    return progress.attempts >= 2 and (
        progress.state == STATE_RELEARNING
        or (progress.stability or 0.0) < SR_CONFIG.weak_stability_days
    )


def is_mastered(progress: TrainingProgress) -> bool:
    return progress.state == STATE_REVIEW and (progress.stability or 0.0) >= SR_CONFIG.mastered_stability_days
