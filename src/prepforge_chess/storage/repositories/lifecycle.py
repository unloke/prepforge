"""Lifecycle persistence."""
from __future__ import annotations

from typing import Dict, Optional
from sqlalchemy import delete, select
from sqlalchemy.engine import Connection
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.base import Repository


class LifecycleRepository(Repository):
    def delete_owner_data(
        self, owner_user_id: str, *, conn: Optional[Connection] = None
    ) -> Dict[str, int]:
        """Delete everything one owner owns, with per-table counts (F-05).

        User content cascades (games → moves/analysis, repertoires →
        nodes/progress/sessions/receipts); shared engine data (positions,
        evaluation snapshots) is intentionally left to the lifecycle reclaim.
        Sessions and reset tokens go with the account so no live credential
        outlives the deletion; share links die with their repertoire row.

        Pass ``conn`` to run inside a caller-owned transaction (D-05): account
        deletion also removes identity rows through an ORM Session, and two
        independent transactions can leave a half-deleted account ("content
        gone, login still works"). Sharing the connection makes it one unit of
        work that either commits or rolls back whole.
        """
        if conn is not None:
            return self._delete_owner_data(conn, owner_user_id)
        with self.engine.begin() as owned:
            return self._delete_owner_data(owned, owner_user_id)

    def _delete_owner_data(self, conn: Connection, owner_user_id: str) -> Dict[str, int]:
        """Conn-scoped body of :meth:`delete_owner_data` (see there for the contract).

        Children go before parents, scoped by subqueries rather than id lists so
        an owner with any number of rows stays under the bind-parameter caps."""
        games = select(t.games.c.id).where(t.games.c.owner_user_id == owner_user_id)
        reps = select(t.repertoires.c.id).where(t.repertoires.c.owner_user_id == owner_user_id)
        sessions = select(t.training_sessions.c.id).where(t.training_sessions.c.repertoire_id.in_(reps))
        steps = (
            ("train_attempt_receipts", t.train_attempt_receipts.c.session_id.in_(sessions)),
            ("training_progress", t.training_progress.c.owner_user_id == owner_user_id),
            ("training_sessions", t.training_sessions.c.repertoire_id.in_(reps)),
            ("analysis_results", t.analysis_results.c.game_id.in_(games)),
            ("moves", t.moves.c.game_id.in_(games)),
            ("games", t.games.c.owner_user_id == owner_user_id),
            ("opening_nodes", t.opening_nodes.c.repertoire_id.in_(reps)),
            ("repertoires", t.repertoires.c.owner_user_id == owner_user_id),
            ("user_settings", t.user_settings.c.user_id == owner_user_id),
        )
        return {
            name: int(conn.execute(delete(getattr(t, name)).where(where)).rowcount)
            for name, where in steps
        }
