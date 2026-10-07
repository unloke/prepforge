"""Per-owner browser analysis preferences."""
from __future__ import annotations

from typing import Any, Optional


STOCKFISH_DEPTH_KEY = "stockfish.depth"
STOCKFISH_DEPTH_DEFAULT = 16
STOCKFISH_DEPTH_MIN = 1
STOCKFISH_DEPTH_MAX = 30

# Maia3's rating conditioning (how "human" the model predicts/plays). ``None`` means
# AUTO: the browser matches the player's own Lichess rating when an account is linked,
# falling back to the client default. Bounds mirror the model's supported range
# (web-src Build → Generate already clamps to the same 600–2600).
MAIA_RATING_KEY = "maia3.rating"
MAIA_RATING_MIN = 600
MAIA_RATING_MAX = 2600


def clamp_stockfish_depth(value: Any, default: int = STOCKFISH_DEPTH_DEFAULT) -> int:
    """Coerce and clamp a browser search depth."""
    try:
        depth = int(value)
    except (TypeError, ValueError):
        depth = default
    return max(STOCKFISH_DEPTH_MIN, min(STOCKFISH_DEPTH_MAX, depth))


def clamp_maia_rating(value: Any) -> Optional[int]:
    """Coerce + clamp a Maia3 rating; a non-integer means AUTO (``None``)."""
    try:
        rating = int(value)
    except (TypeError, ValueError):
        return None
    return max(MAIA_RATING_MIN, min(MAIA_RATING_MAX, rating))


def owner_maia_rating(repo: Any, owner_user_id: str) -> Optional[int]:
    """One owner's pinned Maia3 rating, or ``None`` for AUTO (match the player)."""
    stored = repo.get_user_setting(owner_user_id, MAIA_RATING_KEY, None)
    if stored is None:
        return None
    return clamp_maia_rating(stored)


def owner_stockfish_depth(repo: Any, owner_user_id: str) -> int:
    """One owner's configured analysis depth (clamped; default when unset)."""
    stored = repo.get_user_setting(owner_user_id, STOCKFISH_DEPTH_KEY, STOCKFISH_DEPTH_DEFAULT)
    return clamp_stockfish_depth(stored)
