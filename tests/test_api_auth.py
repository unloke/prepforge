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


def test_me_reports_password_presence_and_updates_display_name(client):
    h = csrf_headers(client)
    client.post(
        "/api/auth/register", json={"email": "p@b.com", "password": "rightpassword"}, headers=h
    )
    me = client.get("/api/auth/me").json()
    assert me["has_password"] is True
    assert "password_hash" not in me

    r = client.patch("/api/auth/me", json={"display_name": "  Magnus  "}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["display_name"] == "Magnus"
    r = client.patch("/api/auth/me", json={"display_name": "   "}, headers=h)
    assert r.json()["display_name"] is None

def test_patch_me_without_display_name_leaves_it_untouched(client):
    """An absent field in a PATCH means leave-as-is, not clear.

    A partial-update verb that erased a field whenever it was missing meant any
    future client sending `PATCH {"theme": ...}` silently wiped the name.
    """
    h = csrf_headers(client)
    client.post(
        "/api/auth/register", json={"email": "keep@b.com", "password": "rightpassword"}, headers=h
    )
    client.patch("/api/auth/me", json={"display_name": "Magnus"}, headers=h)

    # Empty body and an unrelated key must both be no-ops.
    for payload in ({}, {"unrelated": "x"}):
        r = client.patch("/api/auth/me", json=payload, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["display_name"] == "Magnus"

    # An explicit blank still clears, and an explicit null still clears.
    r = client.patch("/api/auth/me", json={"display_name": None}, headers=h)
    assert r.json()["display_name"] is None
    client.patch("/api/auth/me", json={"display_name": "Magnus"}, headers=h)
    r = client.patch("/api/auth/me", json={"display_name": ""}, headers=h)
    assert r.json()["display_name"] is None


def test_display_name_rejects_nul_and_strips_other_control_chars(client):
    """PostgreSQL text columns cannot store NUL; SQLite happily does.

    Accepting it here meant the write failed at the driver with a 500 in
    production while every SQLite-backed test passed.
    """
    h = csrf_headers(client)
    client.post(
        "/api/auth/register", json={"email": "ctl@b.com", "password": "rightpassword"}, headers=h
    )

    r = client.patch("/api/auth/me", json={"display_name": "bad\x00name"}, headers=h)
    assert r.status_code == 422, r.text
    assert client.get("/api/auth/me").json()["display_name"] is None

    # Other C0 controls are stripped rather than rejected.
    r = client.patch("/api/auth/me", json={"display_name": "bell\x07name"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["display_name"] == "bellname"


def test_change_password_rejects_a_password_over_the_documented_cap(client):
    # The UI mirrors this 200-char bound with maxlength; the server is the authority.
    h = csrf_headers(client)
    client.post(
        "/api/auth/register", json={"email": "cap@b.com", "password": "oldpassword1"}, headers=h
    )
    over = "x" * 201
    r = client.post(
        "/api/auth/password/change",
        json={"current_password": "oldpassword1", "new_password": over},
        headers=h,
    )
    assert r.status_code == 422, r.text
    # The rejected attempt must not have changed the password.
    client.post("/api/auth/logout", headers=h)
    h = csrf_headers(client)
    assert client.post(
        "/api/auth/login", json={"email": "cap@b.com", "password": "oldpassword1"}, headers=h
    ).status_code == 200


def test_display_name_is_length_capped_by_code_points(client):
    h = csrf_headers(client)
    client.post(
        "/api/auth/register", json={"email": "len@b.com", "password": "longpassword1"}, headers=h
    )
    assert client.patch("/api/auth/me", json={"display_name": "a" * 120}, headers=h).status_code == 200
    assert client.patch("/api/auth/me", json={"display_name": "a" * 121}, headers=h).status_code == 422


def test_change_password_keeps_this_session_and_ends_others(client):
    from fastapi.testclient import TestClient

    h = csrf_headers(client)
    client.post(
        "/api/auth/register", json={"email": "c@b.com", "password": "oldpassword1"}, headers=h
    )
    other = TestClient(client.app)
    oh = csrf_headers(other)
    assert other.post(
        "/api/auth/login", json={"email": "c@b.com", "password": "oldpassword1"}, headers=oh
    ).status_code == 200

    wrong = client.post(
        "/api/auth/password/change",
        json={"current_password": "nope", "new_password": "newpassword1"},
        headers=h,
    )
    assert wrong.status_code == 400
    r = client.post(
        "/api/auth/password/change",
        json={"current_password": "oldpassword1", "new_password": "newpassword1"},
        headers=h,
    )
    assert r.status_code == 204, r.text
    assert client.get("/api/auth/me").status_code == 200
    assert other.get("/api/auth/me").status_code == 401

    client.post("/api/auth/logout", headers=h)
    h = csrf_headers(client)
    assert client.post(
        "/api/auth/login", json={"email": "c@b.com", "password": "oldpassword1"}, headers=h
    ).status_code == 401
    assert client.post(
        "/api/auth/login", json={"email": "c@b.com", "password": "newpassword1"}, headers=h
    ).status_code == 200
