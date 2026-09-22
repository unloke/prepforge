"""Ephemeral SQLite helper for developer tools and unit tests.

Production schema authority is Alembic (``migrations/``): every production
schema/index change ships as a migration. This module only builds throwaway
SQLite engines for the CLI smoke/dev paths and the non-API unit tests — it
never runs against production and never patches a live schema.
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Union

from sqlalchemy import create_engine, event, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool

from prepforge_chess.storage import sa_tables

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
    """Create the domain tables (idempotent) for an ephemeral SQLite engine.

    FK enforcement is disabled on these throwaway engines (``PRAGMA
    foreign_keys=OFF``): unit tests use synthetic owner ids with no ``users``
    row, and ownership is enforced in application code. Production schema
    (with FKs) comes from Alembic.
    """
    with engine.begin() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
    sa_tables.metadata.create_all(engine, tables=list(sa_tables.DOMAIN_TABLES))


def initialize_database(path: PathLike) -> Engine:
    db_path = Path(path)
    if str(path) != ":memory:":
        db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = connect_database(path)
    apply_schema(engine)
    return engine


def list_tables(engine: Engine) -> List[str]:
    return [name for name in inspect(engine).get_table_names() if not name.startswith("sqlite_")]
