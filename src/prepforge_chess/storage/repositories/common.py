"""Shared Core statement and JSON helpers."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Connection


def _setting_row(user_id: str, key: str, value: Any) -> Dict[str, Any]:
    return {
        "user_id": user_id,
        "key": key,
        "value_json": _json_dump(value),
        "updated_at": datetime.now(timezone.utc),
    }


def _json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def _json_load(value: Optional[str], default: Any) -> Any:
    if value is None:
        return default
    return json.loads(value)


def _parse_critical_ply(value: Optional[str]) -> List[int]:
    if not value:
        return []
    return [int(part) for part in value.split(",") if part]


def _bool_to_int(value: bool) -> int:
    return 1 if value else 0


def _int_to_bool(value: int) -> bool:
    return bool(value)


def _insert(conn: Connection, table):
    """Dialect-aware INSERT so ``on_conflict_do_update`` (upsert) works on both
    backends: Postgres and SQLite spell ``ON CONFLICT`` differently."""
    if conn.dialect.name == "postgresql":
        return pg_insert(table)
    return sqlite_insert(table)


def _upsert(
    conn: Connection,
    table,
    values: Dict[str, Any],
    *,
    conflict: List,
    update_cols: Iterable[str],
    coalesce_cols: Iterable[str] = (),
) -> None:
    """INSERT ... ON CONFLICT DO UPDATE. ``update_cols`` are set from the proposed
    (``excluded``) row; ``coalesce_cols`` keep the existing value when present and
    only fill a gap — used so a re-save never reassigns an established owner."""
    stmt = _insert(conn, table).values(**values)
    set_ = {name: stmt.excluded[name] for name in update_cols}
    for name in coalesce_cols:
        set_[name] = func.coalesce(table.c[name], stmt.excluded[name])
    stmt = stmt.on_conflict_do_update(index_elements=conflict, set_=set_)
    conn.execute(stmt)
