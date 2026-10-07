"""SQLAlchemy engine/session wiring.

One declarative ``Base`` for identity and domain tables. The engine is built
from ``Settings.database_url`` so dev/test use SQLite and production uses
Postgres with a connection pool.
"""
from __future__ import annotations

from collections.abc import Iterator
from threading import Lock

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from prepforge_chess.api.config import Settings, get_settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models in this package."""


def make_engine(settings: Settings | None = None):
    settings = settings or get_settings()
    url = settings.database_url
    if settings.is_sqlite:
        from prepforge_chess.storage.database import make_sqlite_engine

        engine = make_sqlite_engine(url, pool_pre_ping=True)

        # WAL (readers run concurrently with a writer) is a PERSISTENT, file-level
        # setting stored in the DB header -- unlike foreign_keys it survives across
        # connections, so set it once at engine build rather than on every connect
        # (avoids redundant journal-mode churn / startup cost on each pooled connection).
        # The factory registers the listener, so this build-time connection still
        # gets foreign_keys=ON like any other.
        with engine.begin() as conn:
            conn.exec_driver_sql("PRAGMA journal_mode=WAL")

        return engine
    # Postgres: a pooled engine. Sizes are conservative defaults for a small
    # Render instance; tune once load is known.
    return create_engine(url, pool_size=10, max_overflow=20, pool_pre_ping=True)


_engine = None
_SessionLocal: sessionmaker[Session] | None = None
_session_factory_lock = Lock()


def _ensure_session_factory() -> sessionmaker[Session]:
    global _engine, _SessionLocal
    if _SessionLocal is None:
        # First requests can arrive on different worker threads. Publish one
        # engine/factory pair; concurrent SQLite WAL initialization can lock.
        with _session_factory_lock:
            if _SessionLocal is None:
                engine = make_engine()
                factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
                _engine = engine
                _SessionLocal = factory
    return _SessionLocal


def get_engine():
    """The single SQLAlchemy ``Engine`` the app runs on (built lazily from
    ``Settings.database_url``). Identity (ORM) and domain data (Core) share this
    engine and connection pool.
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
