"""Shared fixtures for the SaaS API tests.

Each test gets an isolated SQLite file and a fresh app wired to it. Rate limiting
is disabled by default (so functional tests aren't throttled) and re-enabled only
by the dedicated rate-limit test.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_file = tmp_path / "api_test.sqlite3"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file.as_posix()}")
    monkeypatch.setenv("PREPFORGE_SECRET_KEY", "test-secret-not-for-prod")
    monkeypatch.setenv("PREPFORGE_ENV", "development")

    from prepforge_chess.api import config, db, main
    from prepforge_chess.api.ratelimit import limiter

    config.get_settings.cache_clear()
    db._engine = None
    db._SessionLocal = None
    limiter.enabled = False
    if hasattr(limiter, "reset"):
        limiter.reset()

    # models are registered on db.Base.metadata via the main import chain.
    db.Base.metadata.create_all(db.make_engine())
    return TestClient(main.app)
