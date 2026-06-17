"""Phase 5 (redesigned): teams + repertoire sharing.

Security-critical invariant under test: sharing a repertoire to a team grants team
members **read-only** access and never write access, and a non-member sees nothing.
Team creation is open to every signed-in user; membership/role/invite management is
owner/admin-only. Members are added by **Lichess username** (resolved to the user
who linked that handle) or by redeeming the team's **invite link**.
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


def _link_lichess(user_id: str, username: str) -> None:
    """Attach a Lichess identity to a user. Members are added to teams by their
    Lichess handle, which resolves to the PrepForge user who linked it."""
    from sqlalchemy.orm import Session

    from prepforge_chess.api import db
    from prepforge_chess.api.models import LinkedAccount

    with Session(db.get_engine()) as s:
        s.add(LinkedAccount(user_id=user_id, provider="lichess", provider_user_id=username))
        s.commit()


def _create_team(client: TestClient, name: str = "Coaches") -> str:
    r = client.post("/api/teams", json={"name": name}, headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _add_member(client: TestClient, team_id: str, handle: str, role: str = "member"):
    """POST a member by Lichess handle (the add-by-username contract)."""
    return client.post(
        f"/api/teams/{team_id}/members",
        json={"lichess_username": handle, "role": role},
        headers=csrf_headers(client),
    )


def _create_rep(client: TestClient, name: str = "Repo") -> str:
    r = client.post(
        "/api/repertoires/create",
        json={"name": name, "color": "white"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    return r.json()["repertoire_id"]


def _setup_owner_and_member(owner_client, member_client, role: str = "member"):
    """Owner creates a team and adds one member (by Lichess handle). Returns
    (team_id, member_user_id)."""
    _register(owner_client, "owner@example.com")
    team_id = _create_team(owner_client)
    member_id = _register(member_client, "member@example.com")
    _link_lichess(member_id, "MemberHandle")
    assert _add_member(owner_client, team_id, "MemberHandle", role=role).status_code == 200
    return team_id, member_id


# ---- team creation ---------------------------------------------------------


def test_create_team_requires_auth(client):
    assert client.post("/api/teams", json={"name": "x"}).status_code in (401, 403)


def test_free_user_can_create_team(client):
    # Teams are open to everyone -- a free (non-Pro) user creates one and is its owner.
    _register(client, "free@example.com")
    r = client.post("/api/teams", json={"name": "Free Squad"}, headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["role"] == "owner" and body["member_count"] == 1


def test_create_team_and_is_owner(client):
    _register(client, "owner@example.com")
    r = client.post("/api/teams", json={"name": "Coaches"}, headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["role"] == "owner" and body["member_count"] == 1
    teams = client.get("/api/teams").json()["teams"]
    assert [t["name"] for t in teams] == ["Coaches"]


def test_create_team_whitespace_name_rejected(client):
    _register(client, "owner@example.com")
    r = client.post("/api/teams", json={"name": "   "}, headers=csrf_headers(client))
    assert r.status_code == 422


# ---- membership: add by Lichess handle -------------------------------------


def test_add_member_by_lichess_and_list(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)

    member_client = _new_client()
    member_id = _register(member_client, "member@example.com")
    _link_lichess(member_id, "MemberHandle")

    r = _add_member(client, team_id, "MemberHandle")
    assert r.status_code == 200, r.text
    assert r.json()["lichess_username"] == "MemberHandle"
    detail = client.get(f"/api/teams/{team_id}").json()
    assert {m["email"] for m in detail["members"]} == {"owner@example.com", "member@example.com"}


def test_add_member_case_insensitive_handle(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    member_client = _new_client()
    member_id = _register(member_client, "member@example.com")
    _link_lichess(member_id, "DrNykterstein")
    # Lichess handles are case-insensitive; a differently-cased input still resolves.
    r = _add_member(client, team_id, "drnykterstein")
    assert r.status_code == 200, r.text
    assert r.json()["lichess_username"] == "DrNykterstein"


def test_add_member_unknown_handle_404(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    r = _add_member(client, team_id, "nobody-linked-this")
    assert r.status_code == 404
    assert "invite link" in r.json()["detail"].lower()


def test_add_member_duplicate_409(client):
    member_client = _new_client()
    team_id, _member_id = _setup_owner_and_member(client, member_client)
    # Adding the same handle again -> already a member.
    assert _add_member(client, team_id, "MemberHandle").status_code == 409


def test_plain_member_cannot_add_members(client):
    member_client = _new_client()
    team_id, _member_id = _setup_owner_and_member(client, member_client)

    third = _new_client()
    third_id = _register(third, "third@example.com")
    _link_lichess(third_id, "ThirdHandle")
    # The plain member tries to add a third user -> 403 (not owner/admin).
    assert _add_member(member_client, team_id, "ThirdHandle").status_code == 403


def test_non_member_cannot_see_team(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    outsider = _new_client()
    _register(outsider, "out@example.com")
    assert outsider.get(f"/api/teams/{team_id}").status_code == 404


def test_cannot_remove_owner(client):
    owner_id = _register(client, "owner@example.com")
    team_id = _create_team(client)
    r = client.delete(f"/api/teams/{team_id}/members/{owner_id}", headers=csrf_headers(client))
    assert r.status_code == 400


# ---- membership: role management -------------------------------------------


def test_owner_can_promote_member_to_admin(client):
    member_client = _new_client()
    team_id, member_id = _setup_owner_and_member(client, member_client)
    r = client.patch(
        f"/api/teams/{team_id}/members/{member_id}",
        json={"role": "admin"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "admin"
    detail = client.get(f"/api/teams/{team_id}").json()
    assert {m["user_id"]: m["role"] for m in detail["members"]}[member_id] == "admin"


def test_admin_can_promote_and_demote_others(client):
    # An admin (manager) may flip another non-owner member<->admin.
    admin_client = _new_client()
    team_id, _admin_id = _setup_owner_and_member(client, admin_client, role="admin")
    third = _new_client()
    third_id = _register(third, "third@example.com")
    _link_lichess(third_id, "ThirdHandle")
    _add_member(client, team_id, "ThirdHandle")

    up = admin_client.patch(
        f"/api/teams/{team_id}/members/{third_id}",
        json={"role": "admin"},
        headers=csrf_headers(admin_client),
    )
    assert up.status_code == 200, up.text
    down = admin_client.patch(
        f"/api/teams/{team_id}/members/{third_id}",
        json={"role": "member"},
        headers=csrf_headers(admin_client),
    )
    assert down.status_code == 200 and down.json()["role"] == "member"


def test_admin_can_self_demote(client):
    admin_client = _new_client()
    team_id, admin_id = _setup_owner_and_member(client, admin_client, role="admin")
    r = admin_client.patch(
        f"/api/teams/{team_id}/members/{admin_id}",
        json={"role": "member"},
        headers=csrf_headers(admin_client),
    )
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "member"


def test_cannot_change_owner_role(client):
    owner_id = _register(client, "owner@example.com")
    team_id = _create_team(client)
    r = client.patch(
        f"/api/teams/{team_id}/members/{owner_id}",
        json={"role": "admin"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_cannot_set_role_owner(client):
    member_client = _new_client()
    team_id, member_id = _setup_owner_and_member(client, member_client)
    r = client.patch(
        f"/api/teams/{team_id}/members/{member_id}",
        json={"role": "owner"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_plain_member_cannot_change_roles(client):
    member_client = _new_client()
    team_id, member_id = _setup_owner_and_member(client, member_client)
    r = member_client.patch(
        f"/api/teams/{team_id}/members/{member_id}",
        json={"role": "admin"},
        headers=csrf_headers(member_client),
    )
    assert r.status_code == 403


def test_change_role_unknown_member_404(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    r = client.patch(
        f"/api/teams/{team_id}/members/ghostuser",
        json={"role": "admin"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 404


# ---- invite links ----------------------------------------------------------


def _mint_invite(client, team_id) -> str:
    r = client.post(f"/api/teams/{team_id}/invite", headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    return r.json()["code"]


def test_owner_can_mint_invite_and_member_joins(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    r = client.post(f"/api/teams/{team_id}/invite", headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    assert r.json()["url"] == f"/?join={code}"

    joiner = _new_client()
    _register(joiner, "joiner@example.com")
    preview = joiner.get(f"/api/teams/join/{code}")
    assert preview.status_code == 200
    assert preview.json()["name"] == "Coaches"
    assert preview.json()["already_member"] is False

    joined = joiner.post(f"/api/teams/join/{code}", headers=csrf_headers(joiner))
    assert joined.status_code == 200, joined.text
    assert joined.json()["joined"] is True
    detail = client.get(f"/api/teams/{team_id}").json()
    assert {m["email"] for m in detail["members"]} == {"owner@example.com", "joiner@example.com"}


def test_join_is_idempotent(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    code = _mint_invite(client, team_id)
    joiner = _new_client()
    _register(joiner, "joiner@example.com")
    joiner.post(f"/api/teams/join/{code}", headers=csrf_headers(joiner))
    again = joiner.post(f"/api/teams/join/{code}", headers=csrf_headers(joiner))
    assert again.status_code == 200
    assert again.json() == {**again.json(), "joined": False, "already_member": True}
    detail = client.get(f"/api/teams/{team_id}").json()
    assert sum(1 for m in detail["members"] if m["email"] == "joiner@example.com") == 1


def test_invite_rotate_invalidates_old_code(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    first = _mint_invite(client, team_id)
    second = _mint_invite(client, team_id)
    assert first != second
    joiner = _new_client()
    _register(joiner, "joiner@example.com")
    assert joiner.get(f"/api/teams/join/{first}").status_code == 404
    assert joiner.get(f"/api/teams/join/{second}").status_code == 200


def test_invite_revoke_disables_link(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    code = _mint_invite(client, team_id)
    assert client.delete(f"/api/teams/{team_id}/invite", headers=csrf_headers(client)).status_code == 204
    joiner = _new_client()
    _register(joiner, "joiner@example.com")
    assert joiner.get(f"/api/teams/join/{code}").status_code == 404


def test_invite_unknown_code_404(client):
    joiner = _new_client()
    _register(joiner, "joiner@example.com")
    assert joiner.get("/api/teams/join/nope").status_code == 404
    assert joiner.post("/api/teams/join/nope", headers=csrf_headers(joiner)).status_code == 404


def test_invite_requires_manager(client):
    member_client = _new_client()
    team_id, _member_id = _setup_owner_and_member(client, member_client)
    assert member_client.post(
        f"/api/teams/{team_id}/invite", headers=csrf_headers(member_client)
    ).status_code == 403


def test_join_requires_auth(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    code = _mint_invite(client, team_id)
    anon = _new_client()
    assert anon.get(f"/api/teams/join/{code}").status_code in (401, 403)


def test_team_detail_invite_visible_to_managers_only(client):
    member_client = _new_client()
    team_id, _member_id = _setup_owner_and_member(client, member_client)
    assert client.get(f"/api/teams/{team_id}").json()["invite"] == {"exists": False}
    _mint_invite(client, team_id)
    assert client.get(f"/api/teams/{team_id}").json()["invite"]["exists"] is True
    # A plain member never sees the invite field at all.
    assert "invite" not in member_client.get(f"/api/teams/{team_id}").json()


# ---- sharing + read access (the core acceptance) ---------------------------


def _setup_shared(owner_client, member_client):
    """Owner creates a team, adds a member (by handle), creates + shares a
    repertoire. Returns (team_id, repertoire_id)."""
    team_id, _member_id = _setup_owner_and_member(owner_client, member_client)
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
    r = member_client.post(
        "/api/repertoires/share",
        json={"repertoire_id": rep_id, "team_id": _team_id, "visibility": "private"},
        headers=csrf_headers(member_client),
    )
    assert r.status_code == 404


def test_cannot_share_to_team_you_are_not_in(client):
    _register(client, "owner@example.com")
    rep_id = _create_rep(client, "Mine")

    other = _new_client()
    _register(other, "other@example.com")
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
    client.post(
        "/api/repertoires/share",
        json={"repertoire_id": rep_id, "visibility": "private"},
        headers=csrf_headers(client),
    )
    assert member_client.get(f"/api/build/load?repertoire_id={rep_id}").status_code == 404


def test_build_load_writable_false_for_member(client):
    member_client = _new_client()
    _team_id, rep_id = _setup_shared(client, member_client)
    payload = member_client.get(f"/api/build/load?repertoire_id={rep_id}").json()
    assert payload["writable"] is False


def test_build_load_strips_training_state_for_member(client):
    member_client = _new_client()
    _team_id, rep_id = _setup_shared(client, member_client)
    payload = member_client.get(f"/api/build/load?repertoire_id={rep_id}").json()
    assert payload["writable"] is False
    assert payload.get("shared") is True
    assert "health" not in payload
    assert "summary" not in payload
    assert payload["nodes"]
    assert all("mastery" not in node for node in payload["nodes"])


def test_build_load_keeps_training_state_for_owner(client):
    member_client = _new_client()
    _team_id, rep_id = _setup_shared(client, member_client)
    payload = client.get(f"/api/build/load?repertoire_id={rep_id}").json()
    assert payload["writable"] is True
    assert "health" in payload
    assert "summary" in payload


def test_team_member_can_fork_shared_repertoire(client):
    member_client = _new_client()
    _team_id, rep_id = _setup_shared(client, member_client)
    r = member_client.post(
        "/api/repertoires/fork",
        json={"repertoire_id": rep_id},
        headers=csrf_headers(member_client),
    )
    assert r.status_code == 200, r.text
    fork_id = r.json()["repertoire_id"]
    assert fork_id != rep_id
    load = member_client.get(f"/api/build/load?repertoire_id={fork_id}").json()
    assert load["writable"] is True
    owned = member_client.get("/api/repertoires").json()["repertoires"]
    assert [r["id"] for r in owned] == [fork_id]


def test_fork_shared_repertoire_non_member_404(client):
    member_client = _new_client()
    _team_id, rep_id = _setup_shared(client, member_client)
    outsider = _new_client()
    _register(outsider, "out@example.com")
    r = outsider.post(
        "/api/repertoires/fork",
        json={"repertoire_id": rep_id},
        headers=csrf_headers(outsider),
    )
    assert r.status_code == 404


def test_fork_own_repertoire_400(client):
    _register(client, "owner@example.com")
    rep_id = _create_rep(client, "Mine")
    r = client.post(
        "/api/repertoires/fork",
        json={"repertoire_id": rep_id},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_team_detail_lists_shared_repertoires(client):
    member_client = _new_client()
    team_id, rep_id = _setup_shared(client, member_client)
    detail = client.get(f"/api/teams/{team_id}").json()
    assert [r["id"] for r in detail["shared_repertoires"]] == [rep_id]
    member_detail = member_client.get(f"/api/teams/{team_id}").json()
    assert [r["id"] for r in member_detail["shared_repertoires"]] == [rep_id]


# ---- rename / delete -------------------------------------------------------


def test_rename_team_whitespace_name_rejected(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    r = client.patch(f"/api/teams/{team_id}", json={"name": "   "}, headers=csrf_headers(client))
    assert r.status_code == 422


def test_rename_team_owner(client):
    _register(client, "owner@example.com")
    team_id = _create_team(client, "Old Name")
    r = client.patch(f"/api/teams/{team_id}", json={"name": "New Name"}, headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "New Name"


def test_rename_team_member_forbidden(client):
    member_client = _new_client()
    team_id, _member_id = _setup_owner_and_member(client, member_client)
    assert member_client.patch(
        f"/api/teams/{team_id}",
        json={"name": "Hacked"},
        headers=csrf_headers(member_client),
    ).status_code == 403


def test_delete_team_unshares_repertoires(client):
    member_client = _new_client()
    team_id, rep_id = _setup_shared(client, member_client)
    assert member_client.get(f"/api/build/load?repertoire_id={rep_id}").status_code == 200
    r = client.delete(f"/api/teams/{team_id}", headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    assert member_client.get(f"/api/build/load?repertoire_id={rep_id}").status_code == 404
    meta = client.get("/api/repertoires").json()
    shared_rep = next(r for r in meta["repertoires"] if r["id"] == rep_id)
    assert shared_rep["visibility"] == "private"
    assert shared_rep["team_id"] is None


def test_delete_team_drops_invite(client):
    # Deleting a team cascades its invite row (FK ON DELETE CASCADE).
    _register(client, "owner@example.com")
    team_id = _create_team(client)
    code = _mint_invite(client, team_id)
    assert client.delete(f"/api/teams/{team_id}", headers=csrf_headers(client)).status_code == 200
    joiner = _new_client()
    _register(joiner, "joiner@example.com")
    assert joiner.get(f"/api/teams/join/{code}").status_code == 404


def test_delete_team_admin_forbidden(client):
    admin_client = _new_client()
    team_id, _admin_id = _setup_owner_and_member(client, admin_client, role="admin")
    assert admin_client.delete(
        f"/api/teams/{team_id}", headers=csrf_headers(admin_client)
    ).status_code == 403


def test_owned_repertoire_list_includes_sharing(client):
    member_client = _new_client()
    team_id, rep_id = _setup_shared(client, member_client)
    listing = client.get("/api/repertoires").json()
    shared_rep = next(r for r in listing["repertoires"] if r["id"] == rep_id)
    assert shared_rep["visibility"] == "team"
    assert shared_rep["team_id"] == team_id


def test_share_bad_visibility_400(client):
    _register(client, "owner@example.com")
    rep_id = _create_rep(client, "Mine")
    r = client.post(
        "/api/repertoires/share",
        json={"repertoire_id": rep_id, "visibility": "public"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400
