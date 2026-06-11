"""Daily training streak (Train v2, Phase 3) — services/streak.py.

Pure-function tests: day resolution (client date vs UTC fallback + skew clamp),
the advance fold (extend / same-day no-op / reset / best watermark), and the
view the UI renders (alive vs broken streaks, trained-today flag).
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from prepforge_chess.services import streak


_NOW = datetime(2026, 6, 11, 12, 0, tzinfo=timezone.utc)
_TODAY = _NOW.date()


# ---- resolve_day -------------------------------------------------------------


def test_resolve_day_prefers_sane_client_date():
    # A client just across the date line (UTC+14) is already on "tomorrow".
    assert streak.resolve_day("2026-06-12", now=_NOW) == date(2026, 6, 12)
    assert streak.resolve_day("2026-06-10", now=_NOW) == date(2026, 6, 10)


def test_resolve_day_falls_back_to_utc_on_missing_or_garbage():
    assert streak.resolve_day(None, now=_NOW) == _TODAY
    assert streak.resolve_day("not-a-date", now=_NOW) == _TODAY
    assert streak.resolve_day("", now=_NOW) == _TODAY


def test_resolve_day_clamps_a_broken_clock():
    # No real timezone is 2+ days away from UTC: treat it as a broken clock.
    assert streak.resolve_day("2026-06-14", now=_NOW) == _TODAY
    assert streak.resolve_day("2025-01-01", now=_NOW) == _TODAY


# ---- advance ----------------------------------------------------------------


def test_advance_starts_a_streak_from_nothing():
    assert streak.advance(None, _TODAY) == {
        "current": 1,
        "best": 1,
        "last_day": "2026-06-11",
    }


def test_advance_is_idempotent_within_a_day():
    state = streak.advance(None, _TODAY)
    assert streak.advance(state, _TODAY) == state


def test_advance_extends_on_the_next_day():
    state = streak.advance(None, date(2026, 6, 10))
    state = streak.advance(state, date(2026, 6, 11))
    assert state["current"] == 2
    assert state["best"] == 2
    assert state["last_day"] == "2026-06-11"


def test_advance_resets_after_a_missed_day_but_keeps_best():
    state = {"current": 5, "best": 5, "last_day": "2026-06-08"}
    state = streak.advance(state, _TODAY)  # 2 days skipped
    assert state == {"current": 1, "best": 5, "last_day": "2026-06-11"}


def test_advance_ignores_a_day_behind_the_record():
    # Clock skew may hand us "yesterday" after today already counted; never
    # rewrite history backwards.
    state = {"current": 3, "best": 3, "last_day": "2026-06-11"}
    assert streak.advance(state, date(2026, 6, 10)) == state


def test_advance_survives_corrupt_state():
    assert streak.advance({"current": "x", "last_day": 42}, _TODAY)["current"] == 1
    assert streak.advance("garbage", _TODAY)["current"] == 1


# ---- as_view ----------------------------------------------------------------


def test_view_of_empty_state():
    assert streak.as_view(None, _TODAY) == {
        "current": 0,
        "best": 0,
        "trained_today": False,
    }


def test_view_trained_today_is_alive():
    state = {"current": 4, "best": 6, "last_day": "2026-06-11"}
    assert streak.as_view(state, _TODAY) == {
        "current": 4,
        "best": 6,
        "trained_today": True,
    }


def test_view_trained_yesterday_is_still_alive_but_not_today():
    # The streak survives until the end of today — that's the nudge to train.
    state = {"current": 4, "best": 6, "last_day": "2026-06-10"}
    view = streak.as_view(state, _TODAY)
    assert view["current"] == 4
    assert view["trained_today"] is False


def test_view_of_a_broken_streak_reads_zero():
    state = {"current": 4, "best": 6, "last_day": "2026-06-08"}
    view = streak.as_view(state, _TODAY)
    assert view["current"] == 0
    assert view["best"] == 6
