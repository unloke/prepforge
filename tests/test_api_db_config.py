"""Regression tests for the SaaS engine/config wiring (peer-review fixes).

Two infra bugs the endpoint-port suites don't exercise because they reuse one warm
pooled connection:

* SQLite scopes ``foreign_keys`` per connection and resets it to OFF on each new one,
  so a one-shot PRAGMA only covered the first pooled connection — later ones silently
  skipped FK enforcement (broken cascade deletes). ``make_engine`` must re-assert it on
  every connect.
* ``Settings.database_url`` documented ``PREPFORGE_DATABASE_URL`` as an override but a
  bare ``validation_alias`` replaced the env_prefix, so only ``DATABASE_URL`` worked.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch):
    monkeypatch.setenv("PREPFORGE_SECRET_KEY", "test-secret-not-for-prod")
    monkeypatch.setenv("PREPFORGE_ENV", "development")
    from prepforge_chess.api import config

    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


def test_foreign_keys_on_for_concurrent_connections(tmp_path, monkeypatch):
    db_file = tmp_path / "fk.sqlite3"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file.as_posix()}")
    from prepforge_chess.api import config, db

    config.get_settings.cache_clear()
    engine = db.make_engine()
    # Hold several connections open at once so the pool must open fresh DBAPI
    # connections (not just hand back the one warmed at engine build).
    conns = [engine.connect() for _ in range(3)]
    try:
        flags = [c.exec_driver_sql("PRAGMA foreign_keys").scalar() for c in conns]
    finally:
        for c in conns:
            c.close()
    assert flags == [1, 1, 1]


def test_prefixed_database_url_is_honored(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("PREPFORGE_DATABASE_URL", "sqlite:///from_prefixed.sqlite3")
    from prepforge_chess.api.config import Settings

    assert Settings().database_url == "sqlite:///from_prefixed.sqlite3"


def test_bare_database_url_takes_precedence(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///from_bare.sqlite3")
    monkeypatch.setenv("PREPFORGE_DATABASE_URL", "sqlite:///from_prefixed.sqlite3")
    from prepforge_chess.api.config import Settings

    # AliasChoices order = precedence: the Render/Heroku-convention DATABASE_URL wins.
    assert Settings().database_url == "sqlite:///from_bare.sqlite3"


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        # Render/Heroku hand back bare schemes -> pin to psycopg v3.
        ("postgres://u:p@host:5432/db", "postgresql+psycopg://u:p@host:5432/db"),
        ("postgresql://u:p@host/db", "postgresql+psycopg://u:p@host/db"),
        # Already-driven URLs and sqlite are left untouched.
        ("postgresql+psycopg://u:p@host/db", "postgresql+psycopg://u:p@host/db"),
        ("postgresql+asyncpg://u:p@host/db", "postgresql+asyncpg://u:p@host/db"),
        ("sqlite:///x.sqlite3", "sqlite:///x.sqlite3"),
    ],
)
def test_postgres_url_pinned_to_psycopg(monkeypatch, given, expected):
    monkeypatch.setenv("DATABASE_URL", given)
    from prepforge_chess.api.config import Settings

    assert Settings().database_url == expected
