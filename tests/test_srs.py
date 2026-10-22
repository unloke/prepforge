"""FSRS scheduling for Train (services/srs.py), against FSRS-6 default values."""
from datetime import datetime, timedelta, timezone

import pytest
from fsrs import Rating

from prepforge_chess.core.models import TrainingProgress
from prepforge_chess.services.progress import (
    MASTERY_LEARNING,
    MASTERY_MASTERED,
    MASTERY_WEAK,
    node_mastery,
)
from prepforge_chess.core.sr_config import STATE_LEARNING, STATE_NEW, STATE_RELEARNING, STATE_REVIEW
from prepforge_chess.services.srs import (
    is_mastered,
    is_weak,
    rating_for,
    retrievability,
    review,
)

T0 = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)


def _play(ratings, progress=None):
    """Answer each rating when the move falls due; returns every step."""
    progress = progress or TrainingProgress(node_id="n")
    now, steps = T0, []
    for rating in ratings:
        progress = review(progress, rating, now=now)
        steps.append((progress, progress.due_at - now))
        now = progress.due_at
    return steps


def test_answers_map_to_ratings():
    assert rating_for(True) == Rating.Good
    assert rating_for(True, hinted=True) == Rating.Hard
    assert rating_for(False) == Rating.Again
    assert rating_for(False, hinted=True) == Rating.Again


def test_first_good_graduates_with_fsrs_initial_values():
    (progress, interval), = _play([Rating.Good])
    assert progress.state == STATE_REVIEW and progress.step is None
    assert progress.stability == pytest.approx(2.3065)  # w2
    assert progress.difficulty == pytest.approx(2.1181, abs=1e-4)  # D0(Good)
    assert interval == timedelta(days=2)
    assert (progress.attempts, progress.correct_attempts, progress.lapses) == (1, 1, 0)


def test_intervals_grow_with_each_good_review():
    intervals = [interval.days for _, interval in _play([Rating.Good] * 5)]
    assert intervals == [2, 11, 46, 163, 497]


def test_first_miss_retries_in_ten_minutes():
    (progress, interval), = _play([Rating.Again])
    assert progress.state == STATE_LEARNING
    assert progress.stability == pytest.approx(0.212)  # w0
    assert interval == timedelta(minutes=10)
    assert (progress.correct_attempts, progress.lapses) == (0, 0)  # a learning miss is no lapse


def test_hinted_answer_is_hard_and_not_counted_correct():
    (progress, interval), = _play([Rating.Hard])
    assert progress.stability == pytest.approx(1.2931)  # w1
    assert progress.state == STATE_LEARNING and interval == timedelta(minutes=15)
    assert progress.correct_attempts == 0


def test_lapse_shrinks_stability_and_relearns():
    steps = _play([Rating.Good] * 4 + [Rating.Again, Rating.Good])
    mature, _ = steps[3]
    lapsed, retry = steps[4]
    relearned, next_interval = steps[5]
    assert mature.stability > 100
    assert lapsed.state == STATE_RELEARNING and retry == timedelta(minutes=10)
    assert lapsed.stability < mature.stability / 20
    assert lapsed.difficulty > mature.difficulty
    assert lapsed.lapses == 1 and is_weak(lapsed)
    assert relearned.state == STATE_REVIEW and not is_weak(relearned)
    assert next_interval.days < steps[3][1].days


def test_retrievability_is_desired_retention_at_the_due_date_and_decays():
    (progress, interval), = _play([Rating.Good, Rating.Good])[1:]
    reviewed = progress.last_reviewed_at
    assert retrievability(progress, now=reviewed) == pytest.approx(1.0)
    assert retrievability(progress, now=reviewed + interval) == pytest.approx(0.9, abs=0.005)
    assert retrievability(progress, now=reviewed + 3 * interval) == pytest.approx(0.809, abs=0.005)
    assert retrievability(None) == 0.0
    assert retrievability(TrainingProgress(node_id="n")) == 0.0


def test_weak_and_mastered_follow_the_memory_state():
    fail_twice = [p for p, _ in _play([Rating.Again, Rating.Again])]
    assert not is_weak(fail_twice[0])  # one first miss is just learning
    assert is_weak(fail_twice[1])
    assert node_mastery(fail_twice[1], now=T0) == MASTERY_WEAK
    mastered = [p for p, _ in _play([Rating.Good] * 3)]
    assert [is_mastered(p) for p in mastered] == [False, False, True]  # 46-day stability
    assert node_mastery(mastered[2], now=T0) == MASTERY_MASTERED
    assert node_mastery(mastered[0], now=T0) == MASTERY_LEARNING
    assert TrainingProgress(node_id="n").state == STATE_NEW
