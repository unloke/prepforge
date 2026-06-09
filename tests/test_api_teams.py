"""Phase 5: teams / classroom + repertoire sharing.

The security-critical invariant under test: sharing a repertoire to a team grants
team members **read-only** access and never write access, and a non-member sees
nothing. Team creation is Pro-gated; membership management is owner/admin-only.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from api_helpers import csrf_headers


def _register(client: TestClient, email: str) -> str:
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _new_client() -> TestClient:
    from prepforge_chess.api import main

    return TestClient(main.app)


def _make_pro(user_id: str) -> None:
    """Flip a user to Pro directly (bypasses Stripe — billing is tested separately)."""
    from sqlalchemy.orm import Session

    from prepforge_chess.api import db
    from prepforge_chess.api.models import Plan, User

    with Session(db.get_engine()) as s:
        user = s.get(User, user_id)
        user.plan = Plan.pro
        s.commit()


def _create_team(client: TestClient, name: str = "Coaches") -> str:
    r = client.post("/api/teams", json={"name": name}, headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _create_rep(client: TestClient, name: str = "Repo") -> str:
    r = client.post(
        "/api/repertoires/create",
        json={"name": name, "color": "white"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    return r.json()["repertoire_id"]


# ---- team creation / Pro gating -------------------------------------------


def test_create_team_requires_auth(client):
    assert client.post("/api/teams", json={"name": "x"}).status_code in (401, 403)


def test_create_team_requires_pro(client):
    _register(client, "free@example.com")
    r = client.post("/api/teams", json={"name": "x"}, headers=csrf_headers(client))
    assert r.status_code == 402


def test_pro_can_create_team_and_is_owner(client):
    uid = _register(client, "pro@example.com")
    _make_pro(uid)
    r = client.post("/api/teams", json={"name": "Coaches"}, headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["role"] == "owner" and body["member_count"] == 1
    teams = client.get("/api/teams").json()["teams"]
    assert [t["name"] for t in teams] == ["Coaches"]


# ---- membership management -------------------------------------------------


def test_add_member_by_email_and_list(client):
    owner_id = _register(client, "owner@example.com")
    _make_pro(owner_id)
    team_id = _create_team(client)

    member_client = _new_client()
    _register(member_client, "member@example.com")

    r = client.post(
        f"/api/teams/{team_id}/members",
        json={"email": "member@example.com"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    detail = client.get(f"/api/teams/{team_id}").json()
    assert {m["email"] for m in detail["members"]} == {"owner@example.com", "member@example.com"}


def test_add_member_unknown_email_404(client):
    owner_id = _register(client, "owner@example.com")
    _make_pro(owner_id)
    team_id = _create_team(client)
    r = client.post(
        f"/api/teams/{team_id}/members",
        json={"email": "ghost@example.com"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 404


def test_plain_member_cannot_add_members(client):
    owner_id = _register(client, "owner@example.com")
    _make_pro(owner_id)
    team_id = _create_team(client)

    member_client = _new_client()
    _register(member_client, "member@example.com")
    client.post(
        f"/api/teams/{team_id}/members",
        json={"email": "member@example.com"},
        headers=csrf_headers(client),
    )
    # The member tries to add a third user -> 403 (not owner/admin).
    third = _new_client()
    _register(third, "third@example.com")
    r = member_client.post(
        f"/api/teams/{team_id}/members",
        json={"email": "third@example.com"},
        headers=csrf_headers(member_client),
    )
    assert r.status_code == 403


def test_non_member_cannot_see_team(client):
    owner_id = _register(client, "owner@example.com")
    _make_pro(owner_id)
    team_id = _create_team(client)

    outsider = _new_client()
    _register(outsider, "out@example.com")
    assert outsider.get(f"/api/teams/{team_id}").status_code == 404


def test_cannot_remove_owner(client):
    owner_id = _register(client, "owner@example.com")
    _make_pro(owner_id)
    team_id = _create_team(client)
    r = client.delete(
        f"/api/teams/{team_id}/members/{owner_id}", headers=csrf_headers(client)
    )
    assert r.status_code == 400


# ---- sharing + read access (the core acceptance) ---------------------------


def _setup_shared(owner_client, member_client):
    """owner (Pro) creates a team, adds member, creates + shares a repertoire.
    Returns (team_id, repertoire_id)."""
    owner_id = _register(owner_client, "owner@example.com")
    _make_pro(owner_id)
    team_id = _create_team(owner_client)
    _register(member_client, "member@example.com")
    owner_client.post(
        f"/api/teams/{team_id}/members",
        json={"email": "member@example.com"},
        headers=csrf_headers(owner_client),
    )
    rep_id = _create_rep(owner_client, "Shared London")
    r = owner_client.post(
        "/api/repertoires/share",
        json={"repertoire_id": rep_id, "team_id": team_id, "visibility": "team"},
        headers=csrf_headers(owner_client),
    )
    assert r.status_code == 200, r.text
    return team_id, rep_id


def test_team_member_can_read_shared_repertoire(client):
    member_client = _new_client()
    _team_id, rep_id = _setup_shared(client, member_client)
    # Member reads the shared repertoire's Build payload.
    r = member_client.get(f"/api/build/load?repertoire_id={rep_id}")
    assert r.status_code == 200, r.text
    assert r.json()["repertoire_id"] == rep_id


def test_non_member_cannot_read_shared_repertoire(client):
    member_client = _new_client()
    _team_id, rep_id = _setup_shared(client, member_client)
    outsider = _new_client()
    _register(outsider, "out@example.com")
    assert outsider.get(f"/api/build/load?repertoire_id={rep_id}").status_code == 404


def test_member_cannot_mutate_shared_repertoire(client):
    member_client = _new_client()
    _team_id, rep_id = _setup_shared(client, member_client)
    # Read is allowed, but a write (rename) must be owner-only -> 404.
    r = member_client.post(
        "/api/build/rename",
        json={"repertoire_id": rep_id, "name": "Hacked"},
        headers=csrf_headers(member_client),
    )
    assert r.status_code == 404


def test_shared_repertoire_appears_in_member_list(client):
    member_client = _new_client()
    team_id, rep_id = _setup_shared(client, member_client)
    listing = member_client.get("/api/repertoires").json()
    assert listing["repertoires"] == []  # the member owns none
    assert [s["id"] for s in listing["shared"]] == [rep_id]
    assert listing["shared"][0]["team_id"] == team_id


def test_only_owner_can_share(client):
    member_client = _new_client()
    _team_id, rep_id = _setup_shared(client, member_client)
    # The member is not the repertoire's owner -> cannot change its sharing (404).
    r = member_client.post(
        "/api/repertoires/share",
        json={"repertoire_id": rep_id, "team_id": _team_id, "visibility": "private"},
        headers=csrf_headers(member_client),
    )
    assert r.status_code == 404


def test_cannot_share_to_team_you_are_not_in(client):
    owner_id = _register(client, "owner@example.com")
    _make_pro(owner_id)
    rep_id = _create_rep(client, "Mine")

    # A different Pro user owns another team the first user is not in.
    other = _new_client()
    other_id = _register(other, "other@example.com")
    _make_pro(other_id)
    other_team = _create_team(other, "Other")

    r = client.post(
        "/api/repertoires/share",
        json={"repertoire_id": rep_id, "team_id": other_team, "visibility": "team"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 404


def test_unshare_revokes_member_access(client):
    member_client = _new_client()
    _team_id, rep_id = _setup_shared(client, member_client)
    assert member_client.get(f"/api/build/load?repertoire_id={rep_id}").status_code == 200
    # Owner unshares.
    client.post(
        "/api/repertoires/share",
        json={"repertoire_id": rep_id, "visibility": "private"},
        headers=csrf_headers(client),
    )
    assert member_client.get(f"/api/build/load?repertoire_id={rep_id}").status_code == 404


def test_share_bad_visibility_400(client):
    owner_id = _register(client, "owner@example.com")
    _make_pro(owner_id)
    rep_id = _create_rep(client, "Mine")
    r = client.post(
        "/api/repertoires/share",
        json={"repertoire_id": rep_id, "visibility": "public"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400
