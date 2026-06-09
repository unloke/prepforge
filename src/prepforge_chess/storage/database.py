"""Database factory: builds the SQLAlchemy engine the repository runs on.

Phase 2a-2 swapped the persistence backend from raw ``sqlite3`` to SQLAlchemy
Core. ``connect_database`` / ``initialize_database`` therefore return a SQLAlchemy
``Engine`` (still SQLite for dev/tests, Postgres-ready for prod) rather than a
``sqlite3.Connection``. The DDL is generated from ``storage/sa_tables`` —
``metadata.create_all`` — so the hand-rolled ``schema.sql`` + the runtime
``_apply_migrations`` rebuild machinery the old design needed are gone; the legacy
``schema.sql`` survives only as the drift-guard fixture in ``tests/test_sa_tables.py``
and will be retired with the Alembic baseline (Phase 2a-3).
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Union

from sqlalchemy import create_engine, event, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool

from prepforge_chess.storage import sa_tables

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

PathLike = Union[str, Path]


def connect_database(path: PathLike = ":memory:") -> Engine:
    """Build a SQLite-backed SQLAlchemy engine.

    ``:memory:`` pins a single shared connection (``StaticPool``); without it every
    pooled connection would see a *separate* empty in-memory database and the schema
    created on one would be invisible to the next. File-backed databases use the
    default pool. ``foreign_keys=ON`` is re-asserted on every new DBAPI connection
    because SQLite resets the pragma per connection.
    """
    is_memory = str(path) == ":memory:"
    url = "sqlite://" if is_memory else "sqlite:///{0}".format(path)
    kwargs = {"future": True, "connect_args": {"check_same_thread": False}}
    if is_memory:
        kwargs["poolclass"] = StaticPool
    engine = create_engine(url, **kwargs)

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(dbapi_connection, _record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


def apply_schema(engine: Engine) -> None:
    """Create the legacy domain tables (idempotent) from the SQLAlchemy metadata."""
    sa_tables.metadata.create_all(engine, tables=list(sa_tables.LEGACY_TABLES))


def initialize_database(path: PathLike) -> Engine:
    db_path = Path(path)
    if str(path) != ":memory:":
        db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = connect_database(path)
    apply_schema(engine)
    return engine


def list_tables(engine: Engine) -> List[str]:
    return [name for name in inspect(engine).get_table_names() if not name.startswith("sqlite_")]
