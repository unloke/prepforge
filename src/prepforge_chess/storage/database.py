from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable, Optional, Union


SCHEMA_PATH = Path(__file__).with_name("schema.sql")


PathLike = Union[str, Path]


def connect_database(path: PathLike = ":memory:") -> sqlite3.Connection:
    connection = sqlite3.connect(str(path), check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def apply_schema(connection: sqlite3.Connection, schema_path: Optional[PathLike] = None) -> None:
    path = Path(schema_path) if schema_path is not None else SCHEMA_PATH
    connection.executescript(path.read_text(encoding="utf-8"))
    _apply_migrations(connection)
    connection.commit()


def _apply_migrations(connection: sqlite3.Connection) -> None:
    _ensure_column(connection, "repertoires", "is_active", "INTEGER NOT NULL DEFAULT 1")
    _ensure_column(connection, "opening_nodes", "arrows_json", "TEXT NOT NULL DEFAULT '[]'")
    _ensure_column(connection, "opening_nodes", "circles_json", "TEXT NOT NULL DEFAULT '[]'")


def _ensure_column(
    connection: sqlite3.Connection,
    table: str,
    column: str,
    definition: str,
) -> None:
    rows = connection.execute("PRAGMA table_info({0})".format(table)).fetchall()
    existing = {row[1] if isinstance(row, tuple) else row["name"] for row in rows}
    if column in existing:
        return
    connection.execute(
        "ALTER TABLE {0} ADD COLUMN {1} {2}".format(table, column, definition)
    )


def initialize_database(path: PathLike) -> sqlite3.Connection:
    db_path = Path(path)
    if str(path) != ":memory:":
        db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = connect_database(path)
    apply_schema(connection)
    return connection


def list_tables(connection: sqlite3.Connection) -> Iterable[str]:
    cursor = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    return [row["name"] for row in cursor.fetchall()]
