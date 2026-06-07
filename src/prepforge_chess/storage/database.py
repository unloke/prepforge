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


LEGACY_OWNER_ID = "legacy"


def _apply_migrations(connection: sqlite3.Connection) -> None:
    _ensure_column(connection, "repertoires", "is_active", "INTEGER NOT NULL DEFAULT 1")
    _ensure_column(connection, "opening_nodes", "arrows_json", "TEXT NOT NULL DEFAULT '[]'")
    _ensure_column(connection, "opening_nodes", "circles_json", "TEXT NOT NULL DEFAULT '[]'")
    _apply_multitenancy_migration(connection)


def _apply_multitenancy_migration(connection: sqlite3.Connection) -> None:
    """Per-user data isolation foundation (browser-engine migration → launch track).

    Adds an owner column to the top-level owned entities (games; repertoires already
    carry ``user_profile_id``) plus a cookie-session table that maps a browser to a
    ``user_profiles`` row. Everything else is owned transitively through its parent
    game/repertoire, so only the roots need an owner column.

    Idempotent: safe to run on every startup. Existing rows predate isolation, so they
    are backfilled to a stable ``legacy`` profile rather than left NULL (NULL would be
    invisible to every scoped query and the data would look lost). An operator adopts
    that data by reassigning the legacy owner to their account (see
    ``PrepForgeRepository.reassign_owner``); we never auto-hand legacy data to whoever
    logs in first.
    """
    _ensure_column(connection, "games", "owner_user_id", "TEXT")
    # Drop the legacy GLOBAL unique on games.lichess_id so the same Lichess game can be
    # owned independently by multiple users (per-owner dedup). Only touches old DBs that
    # still carry the column-level UNIQUE; new DBs already ship without it.
    _drop_legacy_global_lichess_unique(connection)

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS user_sessions (
            token_hash TEXT PRIMARY KEY,
            user_profile_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            FOREIGN KEY (user_profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_games_owner ON games(owner_user_id)"
    )
    # Per-owner uniqueness for Lichess games (replaces the dropped global UNIQUE).
    # NULLs are distinct in SQLite indexes, so ownerless rows and non-Lichess games
    # (lichess_id IS NULL) are never constrained.
    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_games_owner_lichess "
        "ON games(owner_user_id, lichess_id)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_repertoires_owner ON repertoires(user_profile_id)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_profile ON user_sessions(user_profile_id)"
    )

    # Backfill: assign any pre-isolation rows to the legacy profile so they remain a
    # coherent, reassignable set instead of becoming invisible NULL-owner orphans.
    has_orphan_games = connection.execute(
        "SELECT 1 FROM games WHERE owner_user_id IS NULL LIMIT 1"
    ).fetchone()
    has_orphan_reps = connection.execute(
        "SELECT 1 FROM repertoires WHERE user_profile_id IS NULL LIMIT 1"
    ).fetchone()
    if has_orphan_games or has_orphan_reps:
        _ensure_legacy_profile(connection)
        connection.execute(
            "UPDATE games SET owner_user_id = ? WHERE owner_user_id IS NULL",
            (LEGACY_OWNER_ID,),
        )
        connection.execute(
            "UPDATE repertoires SET user_profile_id = ? WHERE user_profile_id IS NULL",
            (LEGACY_OWNER_ID,),
        )


def _drop_legacy_global_lichess_unique(connection: sqlite3.Connection) -> None:
    """Rebuild ``games`` without the column-level ``lichess_id ... UNIQUE`` constraint.

    SQLite can't ALTER away a column constraint, so we do the canonical table rebuild
    (create-copy-drop-rename). Guarded: it only fires when the live table SQL still
    contains the global UNIQUE, so it runs at most once and is a no-op on new/migrated
    DBs. ``owner_user_id`` already exists by here (added just above), so it is copied
    across. FKs are toggled off for the swap so the dependent ``moves``/``analysis_results``
    rows (which reference ``games(id)`` by unchanged id) survive the DROP.
    """
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'games'"
    ).fetchone()
    if row is None or not row[0]:
        return
    normalized = " ".join(row[0].lower().split())
    if "lichess_id text unique" not in normalized:
        return  # already rebuilt, or a fresh DB that never had the global UNIQUE

    # PRAGMA foreign_keys is silently ignored inside a transaction, so flush any
    # pending one first to guarantee the toggle below actually takes effect.
    connection.commit()
    connection.execute("PRAGMA foreign_keys=OFF")
    try:
        with connection:
            connection.execute(
                """
                CREATE TABLE games_rebuild (
                    id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    initial_fen TEXT NOT NULL,
                    white TEXT,
                    black TEXT,
                    result TEXT NOT NULL DEFAULT '*',
                    event TEXT,
                    site TEXT,
                    played_at TEXT,
                    pgn TEXT,
                    lichess_id TEXT,
                    tags_json TEXT NOT NULL DEFAULT '{}',
                    owner_user_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                INSERT INTO games_rebuild (
                    id, source, initial_fen, white, black, result, event, site,
                    played_at, pgn, lichess_id, tags_json, owner_user_id,
                    created_at, updated_at
                )
                SELECT
                    id, source, initial_fen, white, black, result, event, site,
                    played_at, pgn, lichess_id, tags_json, owner_user_id,
                    created_at, updated_at
                FROM games
                """
            )
            connection.execute("DROP TABLE games")
            connection.execute("ALTER TABLE games_rebuild RENAME TO games")
    finally:
        connection.execute("PRAGMA foreign_keys=ON")


def _ensure_legacy_profile(connection: sqlite3.Connection) -> None:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    connection.execute(
        """
        INSERT INTO user_profiles (id, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
        """,
        (LEGACY_OWNER_ID, "Legacy (pre-isolation)", now, now),
    )


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
