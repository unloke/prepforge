"""Google OAuth sign-in flow (network calls mocked)."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def google_client(tmp_path, monkeypatch):
    """Like the shared ``client`` fixture but with Google OAuth configured."""
    db_file = tmp_path / "g_test.sqlite3"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file.as_posix()}")
    monkeypatch.setenv("PREPFORGE_SECRET_KEY", "test-secret-not-for-prod")
    monkeypatch.setenv("PREPFORGE_ENV", "development")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-google-client")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-google-secret")

    from prepforge_chess.api import config, db, main
    from prepforge_chess.api.ratelimit import limiter

    config.get_settings.cache_clear()
    db._engine = None
    db._SessionLocal = None
    limiter.enabled = False
    db.Base.metadata.create_all(db.make_engine())
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def _mock_google(monkeypatch):
    monkeypatch.setattr(
        "prepforge_chess.api.routers.google_auth.exchange_code",
        lambda **kw: {"access_token": "google-tok", "token_type": "Bearer"},
    )
    monkeypatch.setattr(
        "prepforge_chess.api.routers.google_auth.fetch_userinfo",
        lambda token, **kw: {"email": "Player@Gmail.com", "name": "Player One"},
    )


def _run_login_flow(client):
    r = client.get("/api/auth/google/login", follow_redirects=False)
    assert r.status_code == 307
    location = r.headers["location"]
    assert location.startswith("https://accounts.google.com/o/oauth2/v2/auth")
    state = parse_qs(urlparse(location).query)["state"][0]
    return client.get(
        f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False
    )


def test_providers_disabled_without_creds(client):
    # Shared client has no Google creds -> google disabled, password always on.
    assert client.get("/api/auth/providers").json() == {"google": False, "password": True}


def test_providers_enabled_with_creds(google_client):
    assert google_client.get("/api/auth/providers").json() == {
        "google": True,
        "password": True,
    }


def test_login_503_when_unconfigured(client):
    assert client.get("/api/auth/google/login", follow_redirects=False).status_code == 503


def test_login_redirects_with_pkce_and_flow_cookie(google_client):
    r = google_client.get("/api/auth/google/login", follow_redirects=False)
    assert r.status_code == 307
    query = parse_qs(urlparse(r.headers["location"]).query)
    assert query["client_id"] == ["test-google-client"]
    assert query["code_challenge_method"] == ["S256"]
    assert "code_challenge" in query
    assert "pf_google_oauth" in r.cookies


def test_callback_creates_user_and_signs_in(google_client):
    r = _run_login_flow(google_client)
    assert r.status_code == 303
    assert r.headers["location"] == "/?signed_in=1"

    status = google_client.get("/api/auth/status").json()
    assert status["signed_in"] is True
    # display_name from Google's name claim is shown.
    assert status["username"] == "Player One"

    # The user was created with the lowercased email and no password.
    from prepforge_chess.api import db

    with db.make_engine().connect() as conn:
        row = conn.exec_driver_sql(
            "SELECT email, password_hash FROM users"
        ).fetchone()
    assert row[0] == "player@gmail.com"
    assert row[1] is None


def test_callback_state_mismatch_rejected(google_client):
    # Start a flow to set the cookie, then submit a different state.
    google_client.get("/api/auth/google/login", follow_redirects=False)
    r = google_client.get(
        "/api/auth/google/callback?code=abc&state=WRONG", follow_redirects=False
    )
    assert r.status_code == 400


def test_callback_binds_to_existing_email_account(google_client, monkeypatch):
    # Pre-create a password account with the same email Google will return.
    from api_helpers import csrf_headers

    google_client.post(
        "/api/auth/register",
        json={"email": "player@gmail.com", "password": "longpassword1"},
        headers=csrf_headers(google_client),
    )
    google_client.post("/api/auth/logout", headers=csrf_headers(google_client))

    _run_login_flow(google_client)

    # Still exactly one user row (bound, not duplicated).
    from prepforge_chess.api import db

    with db.make_engine().connect() as conn:
        count = conn.exec_driver_sql("SELECT COUNT(*) FROM users").fetchone()[0]
    assert count == 1
