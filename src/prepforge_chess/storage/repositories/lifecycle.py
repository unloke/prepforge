"""Lifecycle persistence."""
from __future__ import annotations

from typing import Dict, Optional
from sqlalchemy import delete, func, select
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
        """Conn-scoped body of :meth:`delete_owner_data` (see there for the contract)."""
        counts: Dict[str, int] = {}
        game_ids = [
            row[0]
            for row in conn.execute(
                select(t.games.c.id).where(t.games.c.owner_user_id == owner_user_id)
            ).all()
        ]
        rep_ids = [
            row[0]
            for row in conn.execute(
                select(t.repertoires.c.id).where(
                    t.repertoires.c.owner_user_id == owner_user_id
                )
            ).all()
        ]
        # Receipts hang off training sessions of the owner's repertoires.
        session_ids = [
            row[0]
            for row in conn.execute(
                select(t.training_sessions.c.id).where(
                    t.training_sessions.c.repertoire_id.in_(rep_ids)
                )
            ).all()
        ] if rep_ids else []

        def _count(table, where) -> int:
            return int(
                conn.execute(select(func.count()).select_from(table).where(where)).scalar_one()
            )

        if session_ids:
            counts["train_attempt_receipts"] = _count(
                t.train_attempt_receipts,
                t.train_attempt_receipts.c.session_id.in_(session_ids),
            )
            conn.execute(
                delete(t.train_attempt_receipts).where(
                    t.train_attempt_receipts.c.session_id.in_(session_ids)
                )
            )
        else:
            counts["train_attempt_receipts"] = 0
        counts["training_progress"] = _count(
            t.training_progress, t.training_progress.c.owner_user_id == owner_user_id
        )
        conn.execute(
            delete(t.training_progress).where(
                t.training_progress.c.owner_user_id == owner_user_id
            )
        )
        counts["training_sessions"] = len(session_ids)
        if session_ids:
            conn.execute(
                delete(t.training_sessions).where(
                    t.training_sessions.c.id.in_(session_ids)
                )
            )
        counts["analysis_results"] = (
            _count(t.analysis_results, t.analysis_results.c.game_id.in_(game_ids))
            if game_ids
            else 0
        )
        if game_ids:
            conn.execute(
                delete(t.analysis_results).where(
                    t.analysis_results.c.game_id.in_(game_ids)
                )
            )
        counts["moves"] = (
            _count(t.moves, t.moves.c.game_id.in_(game_ids)) if game_ids else 0
        )
        if game_ids:
            conn.execute(delete(t.moves).where(t.moves.c.game_id.in_(game_ids)))
        counts["games"] = len(game_ids)
        if game_ids:
            conn.execute(delete(t.games).where(t.games.c.id.in_(game_ids)))
        counts["opening_nodes"] = (
            _count(t.opening_nodes, t.opening_nodes.c.repertoire_id.in_(rep_ids))
            if rep_ids
            else 0
        )
        if rep_ids:
            conn.execute(
                delete(t.opening_nodes).where(
                    t.opening_nodes.c.repertoire_id.in_(rep_ids)
                )
            )
        counts["repertoires"] = len(rep_ids)
        if rep_ids:
            conn.execute(
                delete(t.repertoires).where(t.repertoires.c.id.in_(rep_ids))
            )
        counts["user_settings"] = _count(
            t.user_settings, t.user_settings.c.user_id == owner_user_id
        )
        conn.execute(
            delete(t.user_settings).where(t.user_settings.c.user_id == owner_user_id)
        )
        return counts
