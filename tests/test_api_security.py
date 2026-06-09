"""Security baseline: headers, CSRF double-submit, rate limiting."""
from __future__ import annotations

from fastapi.testclient import TestClient

from api_helpers import csrf_headers


def test_security_headers_present(client):
    r = client.get("/healthz")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "camera=()" in r.headers["Permissions-Policy"]
    assert "wasm-unsafe-eval" in r.headers["Content-Security-Policy"]
    assert "worker-src 'self' blob:" in r.headers["Content-Security-Policy"]
    # HSTS is prod-only.
    assert "Strict-Transport-Security" not in r.headers


def test_hsts_in_production(tmp_path, monkeypatch):
    db_file = tmp_path / "prod.sqlite3"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file.as_posix()}")
    monkeypatch.setenv("PREPFORGE_SECRET_KEY", "a-strong-production-secret")
    monkeypatch.setenv("PREPFORGE_ENV", "production")

    from prepforge_chess.api import config, db, main

    config.get_settings.cache_clear()
    db._engine = None
    db._SessionLocal = None
    db.Base.metadata.create_all(db.make_engine())

    prod_app = main.create_app()
    r = TestClient(prod_app).get("/healthz")
    assert r.headers["Strict-Transport-Security"] == "max-age=31536000; includeSubDomains"
    # docs are hidden in production.
    assert TestClient(prod_app).get("/docs").status_code == 404


def test_csrf_required_on_post(client):
    # No CSRF header -> rejected even with a valid body.
    r = client.post("/api/auth/register", json={"email": "x@y.com", "password": "longpassword1"})
    assert r.status_code == 403
    assert "CSRF" in r.json()["detail"]

    # With the bootstrapped token it goes through.
    r = client.post(
        "/api/auth/register",
        json={"email": "x@y.com", "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 201


def test_csrf_endpoint_sets_cookie(client):
    r = client.get("/api/csrf")
    assert r.status_code == 200
    token = r.json()["csrf_token"]
    assert token
    assert client.cookies["pf_csrf"] == token


def test_login_rate_limited(client):
    from prepforge_chess.api.ratelimit import limiter

    limiter.enabled = True
    if hasattr(limiter, "reset"):
        limiter.reset()
    try:
        h = csrf_headers(client)
        client.post(
            "/api/auth/register",
            json={"email": "rl@example.com", "password": "longpassword1"},
            headers=h,
        )
        creds = {"email": "rl@example.com", "password": "longpassword1"}
        statuses = [
            client.post("/api/auth/login", json=creds, headers=h).status_code for _ in range(12)
        ]
        assert 429 in statuses, statuses
    finally:
        limiter.enabled = False
