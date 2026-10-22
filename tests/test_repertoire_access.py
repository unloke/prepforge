"""Repertoire access roles: who may read, copy and edit someone else's repertoire.

The matrix under test: owner > edit > copy > view > nobody. Reads need any role,
copies (fork / export) need copy, tree writes need edit and are rebased like the
owner's, and sharing / rename / delete / enable / Train stay
owner-only. A user's role is the highest of their own grant and their teams'.
The public link grants view or copy, never edit.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api_helpers import csrf_headers
from test_api_teams import _add_member, _create_team, _link_lichess


def _client() -> TestClient:
    from prepforge_chess.api import main

    return TestClient(main.app)


def _register(client: TestClient, email: str, name: str | None = None) -> str:
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1", "display_name": name},
        headers=csrf_headers(client),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _post(client: TestClient, path: str, body: dict):
    return client.post(path, json=body, headers=csrf_headers(client))


def _grant(owner: TestClient, rep: str, role: str, **target):
    r = _post(owner, "/api/repertoires/access", {"repertoire_id": rep, "role": role, **target})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture()
def world(client):
    """Owner with a 1.e4 repertoire, shared with an editor (by email), a copier
    (by Lichess username) and a viewer; plus an outsider with no access."""
    owner = client
    _register(owner, "owner@example.com", "Coach")
    create = _post(owner, "/api/repertoires/create", {"name": "KP", "color": "white"}).json()
    rep, root = create["repertoire_id"], create["selected_node_id"]
    moved = _post(owner, "/api/build/add-move", {"repertoire_id": rep, "parent_node_id": root, "move_uci": "e2e4"})
    assert moved.status_code == 200, moved.text
    users = {}
    for role in ("edit", "copy", "view", "outsider"):
        c = _client()
        users[role] = (c, _register(c, f"{role}@example.com", role.title()))
    _link_lichess(users["copy"][1], "CopierHandle")
    _grant(owner, rep, "edit", person="EDIT@example.com")
    _grant(owner, rep, "copy", person="copierhandle")
    _grant(owner, rep, "view", person="view@example.com")
    clients = {"owner": owner, **{k: v[0] for k, v in users.items()}}
    ids = {k: v[1] for k, v in users.items()}
    e4 = next(n["id"] for n in moved.json()["nodes"] if n.get("san") == "e4")
    return {"rep": rep, "root": root, "e4": e4, "c": clients, "ids": ids}


def _load(client: TestClient, rep: str):
    return client.get(f"/api/build/load?repertoire_id={rep}")


def test_read_role_and_writable_per_role(world):
    rep, c = world["rep"], world["c"]
    expected = {"owner": True, "edit": True, "copy": False, "view": False}
    for who, writable in expected.items():
        body = _load(c[who], rep).json()
        assert body["role"] == who, who
        assert body["writable"] is writable, who
        # Only the owner sees the owner's training state.
        assert ("health" in body) is (who == "owner"), who
        assert all("mastery" not in n for n in body["nodes"]) or who == "owner"
    assert _load(c["outsider"], rep).status_code == 404


def test_copy_needs_copy_role(world):
    rep, c = world["rep"], world["c"]
    fork = lambda who: _post(c[who], "/api/repertoires/fork", {"repertoire_id": rep})  # noqa: E731
    assert fork("owner").status_code == 400
    assert fork("edit").status_code == 200
    assert fork("copy").status_code == 200
    assert fork("view").status_code == 403
    assert fork("outsider").status_code == 404
    export = lambda who: c[who].get(f"/api/repertoires/export-pgn?repertoire_id={rep}")  # noqa: E731
    assert export("copy").status_code == 200
    assert export("view").status_code == 403
    assert _post(c["view"], "/api/build/export", {"repertoire_id": rep, "format": "pgn"}).status_code == 403


def _writes(world):
    rep, root, e4 = world["rep"], world["root"], world["e4"]
    return {
        "add-move": ("/api/build/add-move", {"repertoire_id": rep, "parent_node_id": root, "move_uci": "d2d4"}),
        "add-moves": ("/api/build/add-moves", {"repertoire_id": rep, "moves": [
            {"tempId": "tmp-1", "parentRef": root, "uci": "c2c4"}]}),
        "delete-nodes": ("/api/build/delete-nodes", {"repertoire_id": rep, "node_ids": [e4]}),
        "action": ("/api/build/action", {"repertoire_id": rep, "node_id": e4, "action": "add_comment", "value": "x"}),
        "annotations": ("/api/build/annotations", {"repertoire_id": rep, "node_id": e4, "arrows": ["e2e4"]}),
        "apply-plan": ("/api/build/generate/apply-plan", {"repertoire_id": rep, "root_node_id": root, "plan": {"changes": []}}),
    }


@pytest.mark.parametrize("who,status", [("view", 403), ("copy", 403), ("outsider", 404)])
def test_tree_writes_need_edit(world, who, status):
    for name, (path, body) in _writes(world).items():
        assert _post(world["c"][who], path, body).status_code == status, name


def test_editor_writes_through_the_owner_rebase_path(world):
    rep, root, c = world["rep"], world["root"], world["c"]
    rev = _load(c["owner"], rep).json()["revision"]
    added = _post(c["edit"], "/api/build/add-moves", {
        "repertoire_id": rep,
        "moves": [{"tempId": "tmp-1", "parentRef": root, "uci": "d2d4"}],
    })
    assert added.status_code == 200, added.text
    body = added.json()
    assert body["role"] == "edit" and body["writable"] is True
    assert "health" not in body and body["id_map"]["tmp-1"]
    assert body["revision"] == rev + 1
    owner_view = _load(c["owner"], rep).json()
    assert "d4" in [n.get("san") for n in owner_view["nodes"]]
    # The owner's next edit, made without seeing the editor's, is rebased onto it.
    later = _post(c["owner"], "/api/build/action", {
        "repertoire_id": rep, "node_id": world["e4"], "action": "add_comment", "value": "main",
    })
    assert later.status_code == 200, later.text
    assert later.json()["revision"] == rev + 2
    for name, (path, req) in _writes(world).items():
        if name in ("add-moves", "delete-nodes"):
            continue
        r = _post(c["edit"], path, req)
        assert r.status_code == 200, (name, r.text)
    # The editor's writes left the owner's cached health badge as the owner's.
    assert "health" in _load(c["owner"], rep).json()


def test_owner_only_actions(world):
    rep, c = world["rep"], world["c"]
    ids = world["ids"]
    owner_only = [
        ("/api/build/rename", {"repertoire_id": rep, "name": "Mine now"}),
        ("/api/repertoires/set-active", {"repertoire_id": rep, "active": False}),
        ("/api/repertoires/delete", {"repertoire_id": rep}),
        ("/api/repertoires/share-link", {"repertoire_id": rep}),
        ("/api/repertoires/share-link/revoke", {"repertoire_id": rep}),
        ("/api/repertoires/access", {"repertoire_id": rep, "role": "edit", "user_id": ids["view"]}),
        ("/api/repertoires/access/revoke", {"repertoire_id": rep, "user_id": ids["copy"]}),
        ("/api/train/start", {"repertoire_id": rep}),
    ]
    for path, body in owner_only:
        assert _post(c["edit"], path, body).status_code == 403, path
        assert _post(c["outsider"], path, body).status_code == 404, path
    assert c["edit"].get(f"/api/repertoires/access?repertoire_id={rep}").status_code == 403


def test_access_state_lists_grants_and_changes_roles(world):
    rep, c, ids = world["rep"], world["c"], world["ids"]
    state = c["owner"].get(f"/api/repertoires/access?repertoire_id={rep}").json()
    assert state["link"]["share_enabled"] is False
    assert {(g["name"], g["role"]) for g in state["grants"]} == {("Edit", "edit"), ("Copy", "copy"), ("View", "view")}
    copier = next(g for g in state["grants"] if g["role"] == "copy")
    assert copier["lichess_username"] == "CopierHandle"
    # Promote the viewer; their next load is editable.
    _grant(c["owner"], rep, "edit", user_id=ids["view"])
    assert _load(c["view"], rep).json()["writable"] is True
    # Unknown people, yourself, and role changes for someone not on the list.
    assert _post(c["owner"], "/api/repertoires/access", {"repertoire_id": rep, "person": "nobody@x.test"}).status_code == 404
    assert _post(c["owner"], "/api/repertoires/access", {"repertoire_id": rep, "person": "owner@example.com"}).status_code == 400
    assert _post(c["owner"], "/api/repertoires/access", {"repertoire_id": rep, "user_id": ids["outsider"]}).status_code == 404
    assert _post(c["owner"], "/api/repertoires/access", {"repertoire_id": rep}).status_code == 400


def test_revoke_ends_access_on_the_next_request(world):
    rep, root, c, ids = world["rep"], world["root"], world["c"], world["ids"]
    assert _load(c["edit"], rep).status_code == 200
    r = _post(c["owner"], "/api/repertoires/access/revoke", {"repertoire_id": rep, "user_id": ids["edit"]})
    assert r.status_code == 200
    assert all(g.get("user_id") != ids["edit"] for g in r.json()["grants"])
    assert _load(c["edit"], rep).status_code == 404
    write = _post(c["edit"], "/api/build/add-move", {"repertoire_id": rep, "parent_node_id": root, "move_uci": "d2d4"})
    assert write.status_code == 404
    assert c["edit"].get("/api/repertoires").json()["shared"] == []


def test_shared_with_me_listing(world):
    rep, c = world["rep"], world["c"]
    shared = c["edit"].get("/api/repertoires").json()["shared"]
    assert shared == [{
        "id": rep, "name": "KP", "color": "white", "role": "edit",
        "team_id": None, "owner_display_name": "Coach",
    }]
    assert c["outsider"].get("/api/repertoires").json()["shared"] == []
    assert c["owner"].get("/api/repertoires").json()["repertoires"][0]["shared"] is True


def test_team_role_and_direct_role_take_the_highest(world):
    rep, c, ids = world["rep"], world["c"], world["ids"]
    team = _create_team(c["owner"])
    _link_lichess(ids["view"], "ViewerHandle")
    assert _add_member(c["owner"], team, "ViewerHandle").status_code == 200
    _grant(c["owner"], rep, "edit", team_id=team)
    assert _load(c["view"], rep).json()["role"] == "edit"
    listing = c["view"].get("/api/repertoires").json()["shared"]
    assert [(s["role"], s["team_id"]) for s in listing] == [("edit", team)]
    detail = c["owner"].get(f"/api/teams/{team}").json()
    assert [(r["id"], r["role"]) for r in detail["shared_repertoires"]] == [(rep, "edit")]
    # Leaving the team drops back to the direct grant.
    left = c["view"].request("DELETE", f"/api/teams/{team}/members/{ids['view']}", headers=csrf_headers(c["view"]))
    assert left.status_code == 200, left.text
    assert _load(c["view"], rep).json()["role"] == "view"
    # Deleting the team removes its grant (cascade).
    _add_member(c["owner"], team, "ViewerHandle")
    assert c["owner"].delete(f"/api/teams/{team}", headers=csrf_headers(c["owner"])).status_code == 200
    assert _load(c["view"], rep).json()["role"] == "view"


def test_link_allows_view_or_copy_never_edit(world):
    rep, root, c = world["rep"], world["root"], world["c"]
    minted = _post(c["owner"], "/api/repertoires/share-link", {"repertoire_id": rep}).json()
    assert minted["share_role"] == "view"
    token = minted["token"]
    anon = _client()
    body = anon.get(f"/api/shared/{token}").json()
    assert (body["role"], body["writable"]) == ("view", False)
    assert "health" not in body
    assert _post(c["outsider"], f"/api/shared/{token}/fork", {}).status_code == 403
    # Switching the link to copy keeps the same URL and allows copies.
    same = _post(c["owner"], "/api/repertoires/share-link", {"repertoire_id": rep, "role": "copy"}).json()
    assert same["token"] == token
    assert anon.get(f"/api/shared/{token}").json()["role"] == "copy"
    assert _post(anon, f"/api/shared/{token}/fork", {}).status_code in (401, 403)
    assert _post(c["outsider"], f"/api/shared/{token}/fork", {}).status_code == 200
    # The link alone never opens the tree for writing.
    write = _post(c["outsider"], "/api/build/add-move", {"repertoire_id": rep, "parent_node_id": root, "move_uci": "d2d4"})
    assert write.status_code == 404
    assert _post(c["owner"], "/api/repertoires/share-link", {"repertoire_id": rep, "role": "edit"}).status_code == 422
    state = c["owner"].get(f"/api/repertoires/access?repertoire_id={rep}").json()
    assert state["link"]["url"] == f"/?shared={token}"
    assert state["link"]["share_role"] == "copy"


def test_deleting_the_repertoire_or_the_grantee_removes_grants(world):
    from sqlalchemy import func, select

    from prepforge_chess.api import db
    from prepforge_chess.storage import sa_tables as t

    rep, c = world["rep"], world["c"]
    deleted = c["edit"].request("DELETE", "/api/account", json={"confirm": "DELETE"}, headers=csrf_headers(c["edit"]))
    assert deleted.status_code == 200, deleted.text
    count = lambda: db.get_engine().connect().scalar(select(func.count()).select_from(t.repertoire_access))  # noqa: E731
    assert count() == 2
    assert _post(c["owner"], "/api/repertoires/delete", {"repertoire_id": rep}).status_code == 200
    assert count() == 0
