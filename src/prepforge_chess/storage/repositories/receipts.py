"""Receipts persistence."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional
from sqlalchemy import func, select
from sqlalchemy.engine import Connection
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.common import _bool_to_int, _insert
from prepforge_chess.storage.repositories.base import Repository


class ReceiptRepository(Repository):
    def get_attempt_receipt(
        self, session_id: str, attempt_uuid: str
    ) -> Optional[Dict[str, Any]]:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.train_attempt_receipts).where(
                    t.train_attempt_receipts.c.session_id == session_id,
                    t.train_attempt_receipts.c.attempt_uuid == attempt_uuid,
                )
            ).mappings().first()
        if row is None:
            return None
        return {
            "session_id": row["session_id"],
            "attempt_uuid": row["attempt_uuid"],
            "node_id": row["node_id"],
            "correct": bool(row["correct"]),
        }

    def record_attempt_receipt(
        self, conn: Connection, *, session_id: str, attempt_uuid: str, node_id: str, correct: bool
    ) -> bool:
        """Claim an attempt atomically; return False when its UUID already exists."""
        result = conn.execute(
            _insert(conn, t.train_attempt_receipts).values(
                session_id=session_id,
                attempt_uuid=attempt_uuid,
                node_id=node_id,
                correct=_bool_to_int(correct),
                created_at=datetime.now(timezone.utc),
            ).on_conflict_do_nothing(
                index_elements=[
                    t.train_attempt_receipts.c.session_id,
                    t.train_attempt_receipts.c.attempt_uuid,
                ]
            ).returning(t.train_attempt_receipts.c.attempt_uuid)
        )
        return result.first() is not None

    def count_receipts_before(self, cutoff: datetime) -> int:
        with self.engine.connect() as conn:
            return int(
                conn.execute(
                    select(func.count()).select_from(t.train_attempt_receipts).where(
                        t.train_attempt_receipts.c.created_at < cutoff
                    )
                ).scalar_one()
            )
