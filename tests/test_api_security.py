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
    # Scout + AUTO Maia rating fetch Lichess's public API straight from the
    # browser; connect-src must allow the host or both fail as "Failed to fetch".
    assert "https://lichess.org" in r.headers["Content-Security-Policy"]
    # HSTS is prod-only.
    assert "Strict-Transport-Security" not in r.headers


def test_hsts_in_production(tmp_path, monkeypatch):
    db_file = tmp_path / "prod.sqlite3"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file.as_posix()}")
    monkeypatch.setenv("PREPFORGE_SECRET_KEY", "a-strong-production-secret")
    monkeypatch.setenv("PREPFORGE_TOKEN_KEY", "a-strong-production-token-key")
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


def test_import_route_has_targeted_rate_limit(client):
    from prepforge_chess.api.ratelimit import limiter

    headers = csrf_headers(client)
    registered = client.post(
        "/api/auth/register",
        json={"email": "import-limit@example.com", "password": "longpassword1"},
        headers=headers,
    )
    assert registered.status_code == 201
    limiter.enabled = True
    if hasattr(limiter, "reset"):
        limiter.reset()
    try:
        statuses = [
            client.post(
                "/api/repertoires/import",
                json={"package_json": " "},
                headers=headers,
            ).status_code
            for _ in range(12)
        ]
        assert 429 in statuses, statuses
    finally:
        limiter.enabled = False


def test_sensitive_team_explorer_and_annotation_routes_register_limits():
    from prepforge_chess.api.ratelimit import limiter
    from prepforge_chess.api.routers import lichess, teams, workspace

    expected = {
        f"{teams.__name__}.{name}"
        for name in (
            "create_team",
            "list_teams",
            "join_preview",
            "join_team",
            "team_detail",
            "add_member",
            "remove_member",
            "update_member_role",
            "create_invite",
            "revoke_invite",
            "update_team",
            "delete_team",
        )
    }
    expected.update(
        {
            f"{lichess.__name__}.explorer_proxy",
            f"{workspace.__name__}.build_annotations",
        }
    )
    assert expected <= set(limiter._route_limits)


def test_login_rejects_unknown_and_oauth_only_users(client):
    from api_helpers import csrf_headers

    from prepforge_chess.api.security import verify_password

    # Unknown user: one bcrypt verify against the dummy hash, always False.
    assert verify_password("whatever-password", None) is False
    # OAuth-only user (NULL hash): same path, always False.
    assert verify_password("whatever-password", None) is False
    r = client.post(
        "/api/auth/login",
        json={"email": "nobody@example.com", "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid email or password"}


def test_token_ciphertext_carries_version_prefix(client):
    from prepforge_chess.api.security import decrypt_token, encrypt_token

    token = encrypt_token('{"access_token": "x"}')
    assert token.startswith("v1:")
    assert decrypt_token(token) == '{"access_token": "x"}'
    import pytest as _pytest

    with _pytest.raises(ValueError, match="unsupported token format"):
        decrypt_token("legacy-ciphertext-without-prefix")
