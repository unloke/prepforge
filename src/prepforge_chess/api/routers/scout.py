"""Scout's read of the caller's own repertoire trees: the preparation book
(``storage.prep_trees``), one request for every active repertoire."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from prepforge_chess.api.deps import current_owner, get_repository
from prepforge_chess.storage.ports import UnitOfWork
from prepforge_chess.storage.prep_trees import active_prep_trees

router = APIRouter(prefix="/api/scout", tags=["scout"])


@router.get("/trees")
def scout_trees(
    owner: str = Depends(current_owner),
    repo: UnitOfWork = Depends(get_repository),
) -> dict[str, Any]:
    """Every active repertoire the caller owns, with its tree as
    ``{id, parent_id, uci, depth, is_enabled, is_mainline}`` nodes."""
    return {"repertoires": active_prep_trees(repo.engine, owner)}
