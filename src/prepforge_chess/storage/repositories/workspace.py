"""The one unit-of-work implementation behind every store port.

Domain classes own the implementation. One instance per request shares the
revision fence and the conn-scoped methods, so a transaction can span domains.
Callers depend on the narrow ports in ``prepforge_chess.storage.ports``, not on
this class.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict

from sqlalchemy import func, select

from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.collaboration import CollaborationRepository
from prepforge_chess.storage.repositories.games import GameRepository
from prepforge_chess.storage.repositories.lifecycle import LifecycleRepository
from prepforge_chess.storage.repositories.receipts import ReceiptRepository


class WorkspaceRepository(CollaborationRepository, GameRepository, ReceiptRepository, LifecycleRepository):
    def owner_activity_counts(self, owner_user_id: str, *, now: datetime) -> Dict[str, Any]:
        """The home screen's raw counters for one owner, read on one connection."""
        reps = t.repertoires
        with self.engine.connect() as conn:
            games = conn.execute(
                select(func.count())
                .select_from(t.games)
                .where(t.games.c.owner_user_id == owner_user_id)
            ).scalar_one()
            repertoires = conn.execute(
                select(func.count()).select_from(reps).where(reps.c.owner_user_id == owner_user_id)
            ).scalar_one()
            active_ids = set(conn.scalars(select(reps.c.id).where(
                reps.c.owner_user_id == owner_user_id, reps.c.is_active == 1,
            )))
            sessions = conn.execute(
                select(func.count())
                .select_from(t.training_sessions)
                .where(t.training_sessions.c.owner_user_id == owner_user_id)
            ).scalar_one()
            tp = t.training_progress
            # Moves reviewed in the last 7 days: one progress row per move, so a
            # move reviewed five times counts once.
            reviews_7d = conn.execute(
                select(func.count())
                .select_from(tp)
                .where(
                    tp.c.owner_user_id == owner_user_id,
                    tp.c.last_reviewed_at >= now - timedelta(days=7),
                )
            ).scalar_one()
        return {"games": games, "repertoires": repertoires, "active_ids": active_ids,
                "sessions": sessions, "reviews_7d": reviews_7d}
