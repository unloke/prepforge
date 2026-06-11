"""Ported settings endpoints (Phase 2b-2d-iii) — per-owner preferences.

The only persistent user preference in the browser-compute model is the Stockfish
**depth** the browser runs its analysis at; ``/api/analyze/prepare`` echoes it back as
the hint the SPA's WASM engine should use. Unlike the legacy single-tenant server —
which kept depth in the **global** ``app_settings`` key/value store — the SaaS API
stores it **per owner** on ``user_profiles.settings_json`` (via the same
``get/set_profile_setting`` mechanism that holds the Lichess token), so one tenant's
preference never changes another's analysis.

The legacy ``settings_payload`` also surfaced *server-engine introspection* (Stockfish
binary path/version, CUDA availability, the Maia3 package, an install action). Those are
deliberately **dropped**: the SaaS deploy runs no engine — the browser does — so there
is nothing server-side to introspect or install.
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, StrictInt

from prepforge_chess.api.deps import current_owner, get_repository
from prepforge_chess.services.app_settings import (
    MAIA_RATING_KEY,
    MAIA_RATING_MAX,
    MAIA_RATING_MIN,
    STOCKFISH_DEPTH_DEFAULT,
    STOCKFISH_DEPTH_KEY,
    STOCKFISH_DEPTH_MAX,
    STOCKFISH_DEPTH_MIN,
    clamp_maia_rating,
    clamp_stockfish_depth,
    owner_maia_rating,
    owner_stockfish_depth,
)
from prepforge_chess.storage.repositories import PrepForgeRepository

router = APIRouter(prefix="/api", tags=["settings"])

_DEPTH_RANGE = {
    "min": STOCKFISH_DEPTH_MIN,
    "max": STOCKFISH_DEPTH_MAX,
    "default": STOCKFISH_DEPTH_DEFAULT,
}

_MAIA_RATING_RANGE = {"min": MAIA_RATING_MIN, "max": MAIA_RATING_MAX}


def _settings_payload(repo: PrepForgeRepository, owner: str) -> dict[str, Any]:
    return {
        "stockfish_depth": owner_stockfish_depth(repo, owner),
        "stockfish_depth_range": dict(_DEPTH_RANGE),
        # Maia3's rating conditioning: ``None`` = AUTO (the browser matches the
        # player's linked Lichess rating, falling back to its own default).
        "maia_rating": owner_maia_rating(repo, owner),
        "maia_rating_range": dict(_MAIA_RATING_RANGE),
        # Engines run in the user's browser (WASM); the server stores data, never
        # computes chess — so there is no server-side engine to report on.
        "compute": "browser",
    }


@router.get("/settings")
def get_settings(
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """This owner's analysis preferences (read-only)."""
    return _settings_payload(repo, owner)


class UpdateSettingsBody(BaseModel):
    # StrictInt so a JSON bool/float/string is a 422 request error rather than being
    # silently coerced (``true`` -> depth 1, ``16.5`` -> 16). An out-of-range *integer*
    # is clamped (not rejected), matching the legacy ``set_stockfish_depth``.
    stockfish_depth: StrictInt | None = None
    # An integer pins Maia3 to that rating (clamped to the model's range); the literal
    # ``"auto"`` clears the pin back to match-the-player. ``None`` = field omitted.
    maia_rating: StrictInt | Literal["auto"] | None = None


@router.post("/settings")
def update_settings(
    body: UpdateSettingsBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Persist this owner's analysis preferences and return the refreshed payload."""
    if body.stockfish_depth is not None:
        repo.set_profile_setting(
            owner, STOCKFISH_DEPTH_KEY, clamp_stockfish_depth(body.stockfish_depth)
        )
    if body.maia_rating == "auto":
        repo.set_profile_setting(owner, MAIA_RATING_KEY, None)
    elif body.maia_rating is not None:
        repo.set_profile_setting(owner, MAIA_RATING_KEY, clamp_maia_rating(body.maia_rating))
    return _settings_payload(repo, owner)
