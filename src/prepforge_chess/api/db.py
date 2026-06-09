"""SQLAlchemy engine/session wiring.

One declarative ``Base`` for the new SaaS tables (identity, teams, billing,
sessions). The engine is built from ``Settings.database_url`` so dev/test use
SQLite and production uses Postgres with a real connection pool -- the single
shared-connection + global-lock design of the legacy server is exactly what this
replaces.
"""
from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from prepforge_chess.api.config import Settings, get_settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models in this package."""


def make_engine(settings: Settings | None = None):
    settings = settings or get_settings()
    url = settings.database_url
    if settings.is_sqlite:
        # check_same_thread=False: FastAPI serves requests across a thread pool.
        # We still hand each request its own Session, so this is safe.
        engine = create_engine(
            url,
            connect_args={"check_same_thread": False},
            pool_pre_ping=True,
        )

        # SQLite scopes ``foreign_keys`` PER CONNECTION and resets it to OFF on every
        # new one, so a one-shot PRAGMA only covers the first pooled connection -- the
        # rest would silently skip FK enforcement (broken cascade deletes / orphan
        # rows). Re-assert it on every DBAPI connect, mirroring
        # ``storage.database.make_sqlite_engine``.
        @event.listens_for(engine, "connect")
        def _enable_foreign_keys(dbapi_connection, _record):  # noqa: ANN001
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        # WAL (readers run concurrently with a writer) is a PERSISTENT, file-level
        # setting stored in the DB header -- unlike foreign_keys it survives across
        # connections, so set it once at engine build rather than on every connect
        # (avoids redundant journal-mode churn / startup cost on each pooled connection).
        # The listener above is registered first, so this build-time connection still
        # gets foreign_keys=ON like any other.
        with engine.begin() as conn:
            conn.exec_driver_sql("PRAGMA journal_mode=WAL")

        return engine
    # Postgres: a pooled engine. Sizes are conservative defaults for a small
    # Render instance; tune once load is known.
    return create_engine(url, pool_size=10, max_overflow=20, pool_pre_ping=True)


_engine = None
_SessionLocal: sessionmaker[Session] | None = None


def _ensure_session_factory() -> sessionmaker[Session]:
    global _engine, _SessionLocal
    if _SessionLocal is None:
        _engine = make_engine()
        _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _SessionLocal


def get_engine():
    """The single SQLAlchemy ``Engine`` the app runs on (built lazily from
    ``Settings.database_url``). The legacy ``storage`` repository binds to this same
    engine during the endpoint port (Phase 2b), so identity (ORM) and domain data
    (Core) share one DB/connection pool instead of the old single-connection server.
    """
    _ensure_session_factory()
    return _engine


def get_db() -> Iterator[Session]:
    """FastAPI dependency: yields a request-scoped session, always closed."""
    factory = _ensure_session_factory()
    db = factory()
    try:
        yield db
    finally:
        db.close()
