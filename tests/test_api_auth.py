"""Identity-layer behaviour: register / login / logout / me, with CSRF."""
from __future__ import annotations

from api_helpers import csrf_headers


def test_health(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_register_me_logout_login(client):
    h = csrf_headers(client)
    r = client.post(
        "/api/auth/register",
        json={"email": "Coach@example.com", "password": "hunter2pass", "display_name": "Coach"},
        headers=h,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "coach@example.com"  # normalised to lower-case
    assert body["plan"] == "free"

    r = client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["email"] == "coach@example.com"

    assert "pf_csrf" in client.cookies
    r = client.post("/api/auth/logout", headers=h)
    assert r.status_code == 204
    assert client.get("/api/auth/me").status_code == 401
    # Logout clears both the session cookie and the CSRF cookie.
    set_cookies = r.headers.get_list("set-cookie")
    assert any(c.startswith("pf_session=") and "Max-Age=0" in c for c in set_cookies)
    assert any(c.startswith("pf_csrf=") and "Max-Age=0" in c for c in set_cookies)

    # Logout cleared the CSRF cookie, so the SPA must re-bootstrap a token.
    h = csrf_headers(client)
    r = client.post(
        "/api/auth/login",
        json={"email": "coach@example.com", "password": "hunter2pass"},
        headers=h,
    )
    assert r.status_code == 200
    assert client.get("/api/auth/me").status_code == 200


def test_duplicate_email_rejected(client):
    h = csrf_headers(client)
    payload = {"email": "dup@example.com", "password": "longpassword1"}
    assert client.post("/api/auth/register", json=payload, headers=h).status_code == 201
    assert client.post("/api/auth/register", json=payload, headers=h).status_code == 409


def test_wrong_password_rejected(client):
    h = csrf_headers(client)
    client.post(
        "/api/auth/register", json={"email": "a@b.com", "password": "rightpassword"}, headers=h
    )
    client.post("/api/auth/logout", headers=h)
    h = csrf_headers(client)  # logout cleared the CSRF cookie; re-bootstrap
    r = client.post(
        "/api/auth/login", json={"email": "a@b.com", "password": "wrongpassword"}, headers=h
    )
    assert r.status_code == 401
