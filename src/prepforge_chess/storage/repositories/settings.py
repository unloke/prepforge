"""Settings persistence."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Callable, Any, Dict, Iterable, List
from sqlalchemy import delete, select, update
from sqlalchemy.engine import Connection
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.common import _insert, _json_dump, _json_load, _setting_row
from prepforge_chess.storage.repositories.base import Repository
import logging


logger = logging.getLogger(__name__)


REVIEW_ARCHIVE_KEY = "recap.deleted_reviews"
PLAYED_SESSIONS_KEY = "recap.replaced_sessions"


def prune_review_archive(stamps: Iterable[Any], since_iso: str) -> List[str]:
    return sorted(s for s in stamps if isinstance(s, str) and s >= since_iso)


class SettingsRepository(Repository):
    def get_user_setting(self, user_id: str, key: str, default: Any = None) -> Any:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.user_settings.c.value_json).where(
                    t.user_settings.c.user_id == user_id,
                    t.user_settings.c.key == key,
                )
            ).mappings().first()
        if row is None:
            return default
        try:
            return json.loads(row["value_json"])
        except (json.JSONDecodeError, TypeError):
            logger.warning("Invalid stored setting JSON user=%s key=%s", user_id, key)
            return default

    def set_user_setting(self, user_id: str, key: str, value: Any) -> None:
        """Upsert one setting row. A ``None`` value deletes the key."""
        with self.engine.begin() as conn:
            self.write_user_setting(conn, user_id, key, value)

    def write_user_setting(self, conn: Connection, user_id: str, key: str, value: Any) -> None:
        """Conn-scoped ``set_user_setting``: run inside the caller's transaction so
        the setting write commits together with related domain writes. A ``None``
        value deletes the key."""
        if value is None:
            conn.execute(
                delete(t.user_settings).where(
                    t.user_settings.c.user_id == user_id,
                    t.user_settings.c.key == key,
                )
            )
            return
        stmt = _insert(conn, t.user_settings).values(_setting_row(user_id, key, value))
        stmt = stmt.on_conflict_do_update(
            index_elements=["user_id", "key"],
            set_={"value_json": stmt.excluded.value_json, "updated_at": stmt.excluded.updated_at},
        )
        conn.execute(stmt)

    def lock_user_setting(
        self, conn: Connection, user_id: str, key: str, default: Any = None
    ) -> Any:
        """Read one setting row FOR UPDATE inside an open transaction.

        Insert-claims the row first when absent (``ON CONFLICT DO NOTHING``) so two
        concurrent transactions can never both act on "unset": on PostgreSQL the
        second inserter blocks on the first and then locks the committed row, which
        serialises the whole read-modify-write. ``default`` is returned when the key
        is unset or unparsable. Callers follow up with ``write_user_setting`` (or
        nothing) before the transaction ends.
        """
        conn.execute(
            _insert(conn, t.user_settings)
            .values(_setting_row(user_id, key, default))
            .on_conflict_do_nothing(
                index_elements=[t.user_settings.c.user_id, t.user_settings.c.key]
            )
        )
        row = conn.execute(
            select(t.user_settings.c.value_json)
            .where(
                t.user_settings.c.user_id == user_id,
                t.user_settings.c.key == key,
            )
            .with_for_update()
        ).mappings().first()
        if row is None:
            return default
        try:
            return json.loads(row["value_json"])
        except (json.JSONDecodeError, TypeError):
            return default

    def mutate_user_setting(
        self, user_id: str, key: str, mutator: "Callable[[Any], Any]"
    ) -> Any:
        """Atomically read-modify-write one setting row.

        ``mutator`` receives the current value (or ``None`` if unset) and returns
        the new one; returning ``None`` deletes the key. Row-locked on Postgres
        so concurrent mutators serialise. Unchanged values skip the write.
        """
        with self.engine.begin() as conn:
            row = conn.execute(
                select(t.user_settings.c.value_json)
                .where(
                    t.user_settings.c.user_id == user_id,
                    t.user_settings.c.key == key,
                )
                .with_for_update()
            ).mappings().first()
            try:
                current = json.loads(row["value_json"]) if row is not None else None
            except (json.JSONDecodeError, TypeError):
                current = None
            new_value = mutator(current)
            if new_value == current and (new_value is not None or row is None):
                return new_value
            if row is None and new_value is None:
                return None
            if new_value is None:
                conn.execute(
                    delete(t.user_settings).where(
                        t.user_settings.c.user_id == user_id,
                        t.user_settings.c.key == key,
                    )
                )
            elif row is None:
                conn.execute(t.user_settings.insert().values(_setting_row(user_id, key, new_value)))
            else:
                conn.execute(
                    update(t.user_settings)
                    .where(
                        t.user_settings.c.user_id == user_id,
                        t.user_settings.c.key == key,
                    )
                    .values(value_json=_json_dump(new_value), updated_at=datetime.now(timezone.utc))
                )
        return new_value

    def list_owner_settings(self, owner_user_id: str) -> Dict[str, Any]:
        """All stored settings keys for one owner (account export, F-05)."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(t.user_settings.c.key, t.user_settings.c.value_json).where(
                    t.user_settings.c.user_id == owner_user_id
                )
            ).all()
        return {row[0]: _json_load(row[1], None) for row in rows}
