"""Daily training streak (Train v2, Phase 3).

One tiny per-user fact: how many consecutive *days* the user has trained.
State lives in ``user_profiles.settings_json`` under ``STREAK_KEY`` (no schema
change), shaped ``{"current": int, "best": int, "last_day": "YYYY-MM-DD"}``.

Day boundaries are the *player's* calendar, not the server's: the client sends
its local date with each graded move and the server only sanity-clamps it
(±``_MAX_CLIENT_SKEW_DAYS`` around UTC today) so a wrong clock can't mint or
torch streaks. Missing/invalid dates fall back to UTC today.

Pure module (no DB) — the router glues it to the profile-settings blob.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Optional

STREAK_KEY = "training_streak"

# A client date further than this from UTC today is a broken clock, not a
# timezone: the widest real offsets are UTC-12..UTC+14, i.e. within one day.
_MAX_CLIENT_SKEW_DAYS = 1


def _as_count(raw: Any) -> int:
    """Defensive read of a stored counter — the settings blob is user-state on
    disk, so junk degrades to 0 instead of a 500."""
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 0


def _parse_day(raw: Any) -> Optional[date]:
    if not isinstance(raw, str):
        return None
    try:
        return date.fromisoformat(raw.strip())
    except ValueError:
        return None


def resolve_day(local_date: Optional[str], *, now: Optional[datetime] = None) -> date:
    """The calendar day a training action lands on: the client-reported local
    date when sane, else UTC today."""
    now = now or datetime.now(timezone.utc)
    today_utc = now.date()
    claimed = _parse_day(local_date)
    if claimed is not None and abs((claimed - today_utc).days) <= _MAX_CLIENT_SKEW_DAYS:
        return claimed
    return today_utc


def advance(state: Optional[Dict[str, Any]], day: date) -> Dict[str, Any]:
    """Fold one trained-on ``day`` into the stored state (idempotent per day).

    Consecutive day extends, same day no-ops, anything else restarts at 1.
    A ``day`` *behind* the recorded one (clock skew) is ignored rather than
    allowed to rewrite history.
    """
    state = state if isinstance(state, dict) else {}
    current = _as_count(state.get("current"))
    best = _as_count(state.get("best"))
    last = _parse_day(state.get("last_day"))
    if last is not None and day <= last:
        new_current = max(current, 1)
        new_last = last
    elif last is not None and day - last == timedelta(days=1):
        new_current = current + 1
        new_last = day
    else:
        new_current = 1
        new_last = day
    return {
        "current": new_current,
        "best": max(best, new_current),
        "last_day": new_last.isoformat(),
    }


def as_view(state: Optional[Dict[str, Any]], day: date) -> Dict[str, Any]:
    """What the UI shows *today*: a streak whose last training day is before
    yesterday is already broken, so it reads 0 — not the stale count."""
    state = state if isinstance(state, dict) else {}
    current = _as_count(state.get("current"))
    best = _as_count(state.get("best"))
    last = _parse_day(state.get("last_day"))
    alive = last is not None and (day - last) <= timedelta(days=1)
    return {
        "current": current if alive else 0,
        "best": best,
        "trained_today": last == day,
    }
