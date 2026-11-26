"""Local-first flushes answer with the change feed, not the whole tree.

A Build tab that sends ``since`` (the revision its tree is at) with
``/build/add-moves`` or ``/build/delete-nodes`` gets back only what changed after
it: the written nodes (with the server's recomputed flags), the removed ids, the
``id_map`` and the new revision. ``/build/changes`` builds the same answer from a
structurally loaded tree and skips the tree when no node was written.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from api_helpers import csrf_headers
from fastapi.testclient import TestClient

from prepforge_chess.core.models import TrainingProgress
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository


def _register(client: TestClient, email: str) -> str:
    r = client.post("/api/auth/register", json={"email": email, "password": "longpassword1"},
                    headers=csrf_headers(client))
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _post(client, path, body, device="tab-a"):
    return client.post(path, json=body, headers={**csrf_headers(client), "X-PF-Client": device})


def _load(client, rep):
    return client.get("/api/build/load", params={"repertoire_id": rep}).json()


def _setup(client):
    owner = _register(client, "delta@example.com")
    created = _post(client, "/api/repertoires/create", {"name": "KP", "color": "white"}).json()
    rep, root = created["repertoire_id"], created["selected_node_id"]
    r = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
        {"tempId": "tmp-a-1", "parentRef": root, "uci": "e2e4"},
        {"tempId": "tmp-a-2", "parentRef": "tmp-a-1", "uci": "e7e5"},
        {"tempId": "tmp-a-3", "parentRef": "tmp-a-2", "uci": "g1f3"},
    ]})
    assert r.status_code == 200, r.text
    return owner, rep, root, r.json()["id_map"]


def test_add_moves_with_since_answers_with_only_the_new_nodes(client):
    _owner, rep, _root, ids = _setup(client)
    since = _load(client, rep)["revision"]
    r = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "since": since, "moves": [
        {"tempId": "tmp-b-1", "parentRef": ids["tmp-a-3"], "uci": "b8c6"},
        {"tempId": "tmp-b-2", "parentRef": "tmp-b-1", "uci": "f1b5"},
    ]})
    assert r.status_code == 200, r.text
    reply = r.json()
    full = _load(client, rep)
    by_id = {node["id"]: node for node in full["nodes"]}
    assert reply["revision"] == since + 1 == full["revision"]
    assert set(reply["id_map"]) == {"tmp-b-1", "tmp-b-2"}
    assert sorted(node["id"] for node in reply["nodes"]) == sorted(reply["id_map"].values())
    # Same node shape and server-recomputed flags as /build/load.
    for node in reply["nodes"]:
        assert node == by_id[node["id"]]
    assert reply["removed"] == []
    assert reply["nodes_total"] == full["nodes_total"] == 6
    assert reply["health"] == full["health"]
    assert reply["dropped"] == []
    assert "repertoire_id" not in reply  # not the whole payload


def test_without_since_the_full_payload_still_comes_back(client):
    _owner, rep, root, _ids = _setup(client)
    r = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
        {"tempId": "tmp-c-1", "parentRef": root, "uci": "d2d4"}]})
    assert r.status_code == 200, r.text
    assert len(r.json()["nodes"]) == 5 and r.json()["repertoire_id"] == rep


def test_delete_then_add_with_the_same_since_covers_both(client):
    _owner, rep, root, ids = _setup(client)
    since = _load(client, rep)["revision"]
    d = _post(client, "/api/build/delete-nodes", {"repertoire_id": rep, "since": since,
                                                   "node_ids": [ids["tmp-a-2"]]})
    assert d.status_code == 200, d.text
    assert d.json()["removed"] == sorted([ids["tmp-a-2"], ids["tmp-a-3"]])
    a = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "since": since, "moves": [
        {"tempId": "tmp-d-1", "parentRef": ids["tmp-a-1"], "uci": "c7c5"}]})
    reply = a.json()
    assert reply["revision"] == since + 2
    assert sorted(reply["removed"]) == sorted([ids["tmp-a-2"], ids["tmp-a-3"]])
    assert [node["uci"] for node in reply["nodes"]] == ["c7c5"]


def test_edit_reply_carries_other_devices_writes_since_the_tabs_revision(client):
    _owner, rep, root, ids = _setup(client)
    since = _load(client, rep)["revision"]
    _post(client, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
        {"tempId": "tmp-o-1", "parentRef": root, "uci": "d2d4"}]}, device="tab-b")
    r = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "since": since, "moves": [
        {"tempId": "tmp-e-1", "parentRef": root, "uci": "c2c4"}]})
    reply = r.json()
    assert sorted(node["uci"] for node in reply["nodes"]) == ["c2c4", "d2d4"]
    assert [op["client_id"] for op in reply["ops"]] == ["tab-b", "tab-a"]


def test_a_retried_batch_with_a_newer_since_is_still_the_same_request(client):
    _owner, rep, root, _ids = _setup(client)
    since = _load(client, rep)["revision"]
    moves = [{"tempId": "tmp-r-1", "parentRef": root, "uci": "c2c4"}]
    first = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "since": since, "moves": moves}).json()
    again = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "since": since + 1, "moves": moves}).json()
    assert again["id_map"] == first["id_map"]
    assert again["revision"] == first["revision"]  # replayed, nothing new written


def test_change_feed_matches_the_full_payload_with_training_progress(client):
    owner, rep, root, ids = _setup(client)
    repo = WorkspaceRepository(__import__("prepforge_chess.api.db", fromlist=["get_engine"]).get_engine())
    now = datetime.now(timezone.utc)
    repo.save_training_progress(rep, TrainingProgress(
        node_id=ids["tmp-a-1"], attempts=3, correct_attempts=3, last_reviewed_at=now,
        due_at=now + timedelta(days=9), state=2, stability=20.0, difficulty=3.0), owner_user_id=owner)
    since = _load(client, rep)["revision"]
    _post(client, "/api/build/action", {"repertoire_id": rep, "node_id": ids["tmp-a-1"],
                                         "action": "add_comment", "value": "Main move"}, device="tab-b")
    feed = client.get("/api/build/changes", params={"repertoire_id": rep, "since": since}).json()
    full = _load(client, rep)
    by_id = {node["id"]: node for node in full["nodes"]}
    assert feed["nodes"] and all(node == by_id[node["id"]] for node in feed["nodes"])
    assert by_id[ids["tmp-a-1"]]["mastery"] not in (None, "untrained")
    assert feed["health"] == full["health"]
    assert feed["nodes_total"] == full["nodes_total"]


def test_a_discussion_only_change_does_not_load_the_tree(client, monkeypatch):
    _owner, rep, _root, _ids = _setup(client)
    full = _load(client, rep)
    since = full["revision"]
    r = _post(client, "/api/build/discussions", {"repertoire_id": rep, "fen": full["nodes"][1]["fen"], "body": "Why e5?"})
    assert r.status_code == 200, r.text

    def boom(*_args, **_kwargs):
        raise AssertionError("the change feed loaded the tree for a discussion write")

    monkeypatch.setattr(WorkspaceRepository, "load_repertoire", boom)
    feed = client.get("/api/build/changes", params={"repertoire_id": rep, "since": since}).json()
    assert feed["nodes"] == [] and feed["removed"] == []
    assert feed["name"] == "KP"
    assert [op["kind"] for op in feed["ops"]] == ["discussion"]


def test_an_editors_delta_carries_no_owner_training_colour(client):
    _owner, rep, root, _ids = _setup(client)
    editor = TestClient(client.app)
    _register(editor, "editor@example.com")
    r = _post(client, "/api/repertoires/access", {"repertoire_id": rep, "role": "edit", "person": "editor@example.com"})
    assert r.status_code == 200, r.text
    since = _load(editor, rep)["revision"]
    reply = _post(editor, "/api/build/add-moves", {"repertoire_id": rep, "since": since, "moves": [
        {"tempId": "tmp-x-1", "parentRef": root, "uci": "g1f3"}]}).json()
    assert reply["health"] is None
    assert reply["nodes"] and all("mastery" not in node for node in reply["nodes"])
    assert reply["role"] == "edit"


def test_a_rejected_move_is_named_so_the_rest_can_be_resent(client):
    _owner, rep, root, ids = _setup(client)
    r = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
        {"tempId": "tmp-ok", "parentRef": root, "uci": "d2d4"},
        {"tempId": "tmp-bad", "parentRef": ids["tmp-a-1"], "uci": "e2e4"},
    ]})
    assert r.status_code == 400
    assert r.json()["detail"] == {"error": "move_rejected", "temp_id": "tmp-bad",
                                  "message": r.json()["detail"]["message"]}
    assert "illegal" in r.json()["detail"]["message"]
    # Nothing of the batch landed.
    assert all(node["uci"] != "d2d4" for node in _load(client, rep)["nodes"])
