"""Several devices (and later several editors) on one repertoire.

Every write appends a ``repertoire_ops`` row; ``/api/build/changes`` serves the
catch-up feed; edits are rebased onto the current tree on the server instead of
being refused because the revision moved. Two "devices" here are the same
signed-in client sending different ``X-PF-Client`` ids.
"""
from __future__ import annotations

import threading

from api_helpers import csrf_headers
from fastapi.testclient import TestClient

A = "tab-a"
B = "tab-b"


def _register(client: TestClient, email: str) -> str:
    r = client.post("/api/auth/register", json={"email": email, "password": "longpassword1"},
                    headers=csrf_headers(client))
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _post(client, path, body, device=A):
    return client.post(path, json=body, headers={**csrf_headers(client), "X-PF-Client": device})


def _changes(client, rep, since):
    r = client.get("/api/build/changes", params={"repertoire_id": rep, "since": since})
    assert r.status_code == 200, r.text
    return r.json()


def _load(client, rep):
    return client.get("/api/build/load", params={"repertoire_id": rep}).json()


def _add(client, rep, parent, uci, temp, device=A):
    r = _post(client, "/api/build/add-moves",
              {"repertoire_id": rep, "moves": [{"tempId": temp, "parentRef": parent, "uci": uci}]}, device)
    assert r.status_code == 200, r.text
    return r.json()


def _setup(client, email="sync@example.com"):
    _register(client, email)
    created = _post(client, "/api/repertoires/create", {"name": "KP", "color": "white"}).json()
    rep, root = created["repertoire_id"], created["selected_node_id"]
    e4 = _add(client, rep, root, "e2e4", "tmp-a-1")["id_map"]["tmp-a-1"]
    return rep, root, e4


def _children(payload, parent):
    return sorted(n["uci"] for n in payload["nodes"] if n["parent_id"] == parent)


# ---- the change feed -------------------------------------------------------


def test_unchanged_feed_is_just_the_revision(client):
    rep, _root, _e4 = _setup(client)
    revision = _load(client, rep)["revision"]
    assert _changes(client, rep, revision) == {"revision": revision}


def test_feed_carries_written_nodes_removed_ids_name_and_authorship(client):
    owner = _register(client, "feed@example.com")
    created = _post(client, "/api/repertoires/create", {"name": "KP", "color": "white"}).json()
    rep, root = created["repertoire_id"], created["selected_node_id"]
    seen = _load(client, rep)["revision"]
    e4 = _add(client, rep, root, "e2e4", "tmp-a-1", device=A)["id_map"]["tmp-a-1"]
    feed = _changes(client, rep, seen)
    assert [n["uci"] for n in feed["nodes"]] == ["e2e4"]
    assert feed["nodes"][0]["san"] == "e4"  # the same node shape /build/load serves
    assert feed["ops"] == [{"revision": seen + 1, "kind": "add_moves", "actor_user_id": owner, "client_id": A}]

    e5 = _add(client, rep, e4, "e7e5", "tmp-b-1", device=B)["id_map"]["tmp-b-1"]
    _post(client, "/api/build/rename", {"repertoire_id": rep, "name": "Kings pawn"}, device=B)
    _post(client, "/api/build/delete-nodes", {"repertoire_id": rep, "node_ids": [e4]}, device=B)
    feed = _changes(client, rep, seen + 1)
    assert feed["revision"] == seen + 4
    assert feed["name"] == "Kings pawn"
    assert feed["nodes"] == []  # e5 was written, then went with its parent
    assert feed["removed"] == sorted([e4, e5])
    assert [(op["kind"], op["client_id"]) for op in feed["ops"]] == [
        ("add_moves", B), ("rename", B), ("delete_nodes", B)]


def test_feed_resets_when_the_log_no_longer_reaches_back(client, monkeypatch):
    from prepforge_chess.storage.repositories import repertoires

    monkeypatch.setattr(repertoires, "OPS_KEPT", 2)
    monkeypatch.setattr(repertoires, "OPS_TRIM_EVERY", 1)
    rep, root, e4 = _setup(client)
    start = _load(client, rep)["revision"]
    for i, uci in enumerate(("d2d4", "c2c4", "g1f3")):
        _add(client, rep, root, uci, f"tmp-a-{i + 10}")
    assert _changes(client, rep, start) == {"revision": start + 3, "reset": True}
    assert _changes(client, rep, start + 1)["revision"] == start + 3
    # A brand-new repertoire's first op replaced the whole tree: reload it.
    assert _changes(client, rep, 0)["reset"] is True


def test_feed_is_gated_by_read_access(client):
    rep, _root, _e4 = _setup(client)
    client.post("/api/auth/logout", headers=csrf_headers(client))
    _register(client, "stranger@example.com")
    r = client.get("/api/build/changes", params={"repertoire_id": rep, "since": 0})
    assert r.status_code == 404


# ---- server-side rebase ------------------------------------------------------


def test_concurrent_non_conflicting_edits_both_survive(client):
    rep, root, e4 = _setup(client)
    base = _load(client, rep)["revision"]
    # Both devices last saw ``base``; neither knows about the other's edit.
    _add(client, rep, e4, "e7e5", "tmp-a-2", device=A)
    _add(client, rep, root, "d2d4", "tmp-b-1", device=B)
    _post(client, "/api/build/action", {"repertoire_id": rep, "node_id": e4, "action": "add_comment",
                                        "value": "main"}, device=B)
    tree = _load(client, rep)
    assert tree["revision"] == base + 3
    assert _children(tree, root) == ["d2d4", "e2e4"]
    assert _children(tree, e4) == ["e7e5"]
    assert next(n for n in tree["nodes"] if n["id"] == e4)["comment"] == "main"


def test_add_under_a_line_deleted_elsewhere_is_dropped_not_rejected(client):
    rep, root, e4 = _setup(client)
    e5 = _add(client, rep, e4, "e7e5", "tmp-a-2")["id_map"]["tmp-a-2"]
    _post(client, "/api/build/delete-nodes", {"repertoire_id": rep, "node_ids": [e4]}, device=A)
    # Device B, still showing e4 → e5, extends the line and adds elsewhere.
    reply = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
        {"tempId": "tmp-b-1", "parentRef": e5, "uci": "g1f3"},
        {"tempId": "tmp-b-2", "parentRef": "tmp-b-1", "uci": "b8c6"},
        {"tempId": "tmp-b-3", "parentRef": root, "uci": "d2d4"},
    ]}, device=B)
    assert reply.status_code == 200, reply.text
    body = reply.json()
    assert body["dropped"] == ["tmp-b-1", "tmp-b-2"]
    assert list(body["id_map"]) == ["tmp-b-3"]
    assert _children(_load(client, rep), root) == ["d2d4"]


def test_add_with_an_unknown_tmp_parent_is_still_malformed(client):
    rep, _root, _e4 = _setup(client)
    reply = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
        {"tempId": "tmp-b-9", "parentRef": "tmp-never-sent", "uci": "e7e5"}]})
    assert reply.status_code == 400


def test_both_devices_delete_the_same_line(client):
    rep, root, e4 = _setup(client)
    d4 = _add(client, rep, root, "d2d4", "tmp-a-2")["id_map"]["tmp-a-2"]
    first = _post(client, "/api/build/delete-nodes", {"repertoire_id": rep, "node_ids": [e4]}, device=A)
    # B's batch also names e4 (already gone): that part is a no-op, the rest lands.
    second = _post(client, "/api/build/delete-nodes", {"repertoire_id": rep, "node_ids": [e4, d4]}, device=B)
    assert first.status_code == second.status_code == 200
    assert first.json()["removed_node_ids"] == [e4]
    assert second.json()["removed_node_ids"] == [d4]
    assert _children(_load(client, rep), root) == []


def test_edits_on_a_node_deleted_elsewhere_are_409_node_deleted(client):
    rep, root, e4 = _setup(client)
    _add(client, rep, root, "d2d4", "tmp-a-2")
    _post(client, "/api/build/delete-nodes", {"repertoire_id": rep, "node_ids": [e4]}, device=A)
    revision = _load(client, rep)["revision"]
    attempts = [
        ("/api/build/action", {"node_id": e4, "action": "set_mainline"}),
        ("/api/build/action", {"node_id": e4, "action": "add_comment", "value": "x"}),
        ("/api/build/action", {"node_id": e4, "action": "disable_branch"}),
        ("/api/build/annotations", {"node_id": e4, "arrows": ["Ge2e4"]}),
        ("/api/build/add-move", {"parent_node_id": e4, "move_uci": "e7e5"}),
        ("/api/build/generate/apply-plan", {"root_node_id": e4, "plan": {"changes": []}}),
    ]
    for path, body in attempts:
        r = _post(client, path, {"repertoire_id": rep, **body}, device=B)
        assert r.status_code == 409, (path, r.text)
        assert r.json()["detail"]["error"] == "node_deleted"
    assert _load(client, rep)["revision"] == revision  # nothing was written


def test_concurrent_renames_and_mainline_picks_are_last_writer_wins(client):
    rep, root, e4 = _setup(client)
    d4 = _add(client, rep, root, "d2d4", "tmp-a-2")["id_map"]["tmp-a-2"]
    _post(client, "/api/build/rename", {"repertoire_id": rep, "name": "From A"}, device=A)
    _post(client, "/api/build/rename", {"repertoire_id": rep, "name": "From B"}, device=B)
    _post(client, "/api/build/action", {"repertoire_id": rep, "node_id": d4, "action": "set_mainline"}, device=A)
    _post(client, "/api/build/action", {"repertoire_id": rep, "node_id": e4, "action": "set_mainline"}, device=B)
    tree = _load(client, rep)
    assert tree["name"] == "From B"
    mainline = [n["uci"] for n in tree["nodes"] if n["parent_id"] == root and n["is_mainline"]]
    assert mainline == ["e2e4"]


def test_disable_and_enable_are_explicit_so_a_repeat_is_idempotent(client):
    rep, _root, e4 = _setup(client)
    for device in (A, B):  # both devices disable the same branch
        _post(client, "/api/build/action", {"repertoire_id": rep, "node_id": e4, "action": "disable_branch"}, device)
    assert next(n for n in _load(client, rep)["nodes"] if n["id"] == e4)["is_enabled"] is False
    _post(client, "/api/build/action", {"repertoire_id": rep, "node_id": e4, "action": "enable_branch"})
    assert next(n for n in _load(client, rep)["nodes"] if n["id"] == e4)["is_enabled"] is True


def test_a_write_landing_mid_request_is_rebased_not_lost(client, monkeypatch):
    """Another write commits between this request's tree read and its commit:
    the fence rolls this attempt back and the edit re-runs on the newer tree."""
    from prepforge_chess.services.opening_builder import OpeningBuilderService

    rep, root, e4 = _setup(client)
    base = _load(client, rep)["revision"]
    original = OpeningBuilderService.add_moves_batch
    raced = []

    def racing(self, repertoire_id, moves, **kwargs):
        if not raced:
            raced.append(True)
            competitor = OpeningBuilderService(type(self.repository)(self.repository.engine))
            competitor.delete_nodes_batch(repertoire_id, [e4])  # lands first
        return original(self, repertoire_id, moves, **kwargs)

    monkeypatch.setattr(OpeningBuilderService, "add_moves_batch", racing)
    reply = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
        {"tempId": "tmp-b-1", "parentRef": e4, "uci": "e7e5"},
        {"tempId": "tmp-b-2", "parentRef": root, "uci": "d2d4"}]}, device=B)
    assert reply.status_code == 200, reply.text
    assert reply.json()["dropped"] == ["tmp-b-1"]  # re-run saw e4 gone
    tree = _load(client, rep)
    assert tree["revision"] == base + 2
    assert _children(tree, root) == ["d2d4"]
    revisions = [op["revision"] for op in _changes(client, rep, base)["ops"]]
    assert revisions == [base + 1, base + 2]


def test_parallel_writers_keep_one_contiguous_op_per_revision(client):
    rep, root, e4 = _setup(client)
    base = _load(client, rep)["revision"]
    cookies = dict(client.cookies)
    errors = []

    def writer(device, parent, moves):
        from prepforge_chess.api import main

        own = TestClient(main.app, cookies=cookies)
        for i, uci in enumerate(moves):
            r = _post(own, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
                {"tempId": f"tmp-{device}-{i}", "parentRef": parent, "uci": uci}]}, device)
            if r.status_code != 200:
                errors.append(r.text)

    threads = [
        threading.Thread(target=writer, args=(A, root, ["d2d4", "c2c4", "g1f3", "b2b3"])),
        threading.Thread(target=writer, args=(B, e4, ["e7e5", "c7c5", "e7e6", "c7c6"])),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    tree = _load(client, rep)
    assert tree["revision"] == base + 8
    assert len(_children(tree, root)) == 5 and len(_children(tree, e4)) == 4
    feed = _changes(client, rep, base)
    assert [op["revision"] for op in feed["ops"]] == list(range(base + 1, base + 9))
    assert len(feed["nodes"]) == 8


# ---- several accounts ----------------------------------------------------------


def _account(email):
    from prepforge_chess.api import main

    other = TestClient(main.app)
    return other, _register(other, email)


def _share(owner_client, rep, role, email):
    r = _post(owner_client, "/api/repertoires/access", {"repertoire_id": rep, "role": role, "person": email})
    assert r.status_code == 200, r.text


def test_an_editor_on_another_account_co_edits_live(client):
    rep, root, e4 = _setup(client, "owner@example.com")
    owner_id = client.get("/api/auth/me").json()["id"]
    editor, editor_id = _account("editor@example.com")
    viewer, _viewer_id = _account("viewer@example.com")
    _share(client, rep, "edit", "editor@example.com")
    _share(client, rep, "view", "viewer@example.com")
    base = _load(client, rep)["revision"]

    # Both last saw ``base``; owner and editor add on different lines at once.
    results = []

    def write(who, parent, uci, temp):
        r = _post(who, "/api/build/add-moves",
                  {"repertoire_id": rep, "moves": [{"tempId": temp, "parentRef": parent, "uci": uci}]})
        results.append(r.status_code)

    threads = [threading.Thread(target=write, args=(client, e4, "e7e5", "tmp-o")),
               threading.Thread(target=write, args=(editor, root, "d2d4", "tmp-e"))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results == [200, 200]
    tree = _load(client, rep)
    assert tree["revision"] == base + 2
    assert _children(tree, root) == ["d2d4", "e2e4"] and _children(tree, e4) == ["e7e5"]

    # The editor's write reaches the owner's feed, signed by the editor.
    feed = _changes(client, rep, base)
    assert sorted(op["actor_user_id"] for op in feed["ops"]) == sorted([owner_id, editor_id])
    assert {n["uci"] for n in feed["nodes"]} == {"e7e5", "d2d4"}
    assert "health" in feed

    # The editor and the viewer read the same feed without the owner's training colour.
    for reader in (editor, viewer):
        seen = _changes(reader, rep, base)
        assert seen["revision"] == base + 2 and seen["health"] is None
        assert all("mastery" not in n for n in seen["nodes"])

    # The viewer may not write; a revoked editor no longer sees the repertoire.
    denied = _post(viewer, "/api/build/add-moves",
                   {"repertoire_id": rep, "moves": [{"tempId": "tmp-v", "parentRef": root, "uci": "c2c4"}]})
    assert denied.status_code == 403
    revoked = _post(client, "/api/repertoires/access/revoke", {"repertoire_id": rep, "user_id": editor_id})
    assert revoked.status_code == 200, revoked.text
    gone = _post(editor, "/api/build/add-moves",
                 {"repertoire_id": rep, "moves": [{"tempId": "tmp-e2", "parentRef": root, "uci": "c2c4"}]})
    assert gone.status_code == 404
    assert editor.get("/api/build/changes", params={"repertoire_id": rep, "since": base}).status_code == 404


def test_rename_stays_owner_only_and_is_logged(client):
    rep, _root, _e4 = _setup(client, "owner@example.com")
    owner_id = client.get("/api/auth/me").json()["id"]
    editor, _ = _account("editor@example.com")
    _share(client, rep, "edit", "editor@example.com")
    base = _load(client, rep)["revision"]
    assert _post(editor, "/api/build/rename", {"repertoire_id": rep, "name": "Mine"}).status_code == 403
    assert _post(client, "/api/build/rename", {"repertoire_id": rep, "name": "Kings pawn"}).status_code == 200
    feed = _changes(editor, rep, base)
    assert feed["name"] == "Kings pawn"
    assert [(op["kind"], op["actor_user_id"]) for op in feed["ops"]] == [("rename", owner_id)]
