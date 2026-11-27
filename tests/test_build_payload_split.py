"""The Build payload is the tree alone; training colour and the book are their own reads.

* ``/api/build/load`` (and the change feed) carry the tree and the caller's role,
  never the owner's mastery or health badge, whoever asks.
* ``/api/train/mastery`` is Train's projection over that tree: the owner's
  per-node mastery at the tree's revision, owner-only.
* A tree edit, by the owner or an editor, keeps the owner's Library badge current.
* ``/api/analyze/book`` is Analyze's slim read of every active repertoire.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from api_helpers import csrf_headers
from fastapi.testclient import TestClient

from prepforge_chess.core.models import TrainingProgress
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository


def _client() -> TestClient:
    from prepforge_chess.api import main

    return TestClient(main.app)


def _register(client: TestClient, email: str) -> str:
    r = client.post("/api/auth/register", json={"email": email, "password": "longpassword1"},
                    headers=csrf_headers(client))
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _post(client: TestClient, path: str, body: dict):
    return client.post(path, json=body, headers=csrf_headers(client))


def _setup(client: TestClient):
    owner = _register(client, "split@example.com")
    created = _post(client, "/api/repertoires/create", {"name": "KP", "color": "white"}).json()
    rep, root = created["repertoire_id"], created["selected_node_id"]
    r = _post(client, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
        {"tempId": "tmp-1", "parentRef": root, "uci": "e2e4"},
        {"tempId": "tmp-2", "parentRef": "tmp-1", "uci": "e7e5"},
        {"tempId": "tmp-3", "parentRef": "tmp-2", "uci": "g1f3"},
    ]})
    assert r.status_code == 200, r.text
    return owner, rep, root, r.json()["id_map"]


def _train(owner: str, rep: str, node_id: str) -> None:
    repo = WorkspaceRepository(__import__("prepforge_chess.api.db", fromlist=["get_engine"]).get_engine())
    now = datetime.now(timezone.utc)
    repo.save_training_progress(rep, TrainingProgress(
        node_id=node_id, attempts=3, correct_attempts=3, last_reviewed_at=now,
        due_at=now + timedelta(days=9), state=2, stability=20.0, difficulty=3.0), owner_user_id=owner)


def _badge(client: TestClient, rep: str) -> dict:
    rows = client.get("/api/repertoires").json()["repertoires"]
    return next(row for row in rows if row["id"] == rep)["health"]


def _share(owner: TestClient, rep: str, role: str, email: str) -> TestClient:
    other = _client()
    _register(other, email)
    r = _post(owner, "/api/repertoires/access", {"repertoire_id": rep, "role": role, "person": email})
    assert r.status_code == 200, r.text
    return other


def test_the_owners_build_payload_is_the_tree_alone(client):
    owner, rep, _root, ids = _setup(client)
    _train(owner, rep, ids["tmp-1"])
    body = client.get("/api/build/load", params={"repertoire_id": rep}).json()
    assert body["role"] == "owner" and body["writable"] is True
    assert "health" not in body
    assert body["nodes"] and all("mastery" not in node for node in body["nodes"])


def test_mastery_is_trains_owner_only_read_at_the_trees_revision(client):
    owner, rep, _root, ids = _setup(client)
    _train(owner, rep, ids["tmp-1"])
    tree = client.get("/api/build/load", params={"repertoire_id": rep}).json()
    r = client.get("/api/train/mastery", params={"repertoire_id": rep})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"repertoire_id", "revision", "mastery"}
    assert body["repertoire_id"] == rep and body["revision"] == tree["revision"]
    # Own-side moves only (White's e4 and Nf3), the trained one coloured.
    assert set(body["mastery"]) == {ids["tmp-1"], ids["tmp-3"]}
    assert body["mastery"][ids["tmp-1"]] not in ("untrained", None)
    assert body["mastery"][ids["tmp-3"]] == "untrained"

    editor = _share(client, rep, "edit", "split-editor@example.com")
    assert editor.get("/api/train/mastery", params={"repertoire_id": rep}).status_code == 403
    outsider = _client()
    _register(outsider, "split-outsider@example.com")
    assert outsider.get("/api/train/mastery", params={"repertoire_id": rep}).status_code == 404


def test_a_tree_edit_keeps_the_owners_badge_current_whoever_edits(client):
    _owner, rep, _root, ids = _setup(client)
    assert _badge(client, rep)["trainable"] == 2
    editor = _share(client, rep, "edit", "split-badge@example.com")
    reply = _post(editor, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
        {"tempId": "tmp-e-1", "parentRef": ids["tmp-3"], "uci": "b8c6"},
        {"tempId": "tmp-e-2", "parentRef": "tmp-e-1", "uci": "f1b5"},
    ]})
    assert reply.status_code == 200, reply.text
    assert "health" not in reply.json()
    assert _badge(client, rep)["trainable"] == 3


def test_the_change_feed_carries_no_training_state(client):
    owner, rep, root, _ids = _setup(client)
    since = client.get("/api/build/load", params={"repertoire_id": rep}).json()["revision"]
    _post(client, "/api/build/add-moves", {"repertoire_id": rep, "moves": [
        {"tempId": "tmp-f-1", "parentRef": root, "uci": "d2d4"}]})
    feed = client.get("/api/build/changes", params={"repertoire_id": rep, "since": since}).json()
    assert feed["nodes"] and "health" not in feed
    assert all("mastery" not in node for node in feed["nodes"])


def test_the_analyze_book_is_every_active_tree_slim(client):
    _owner, rep, _root, ids = _setup(client)
    other = _post(client, "/api/repertoires/create", {"name": "Off", "color": "black"}).json()["repertoire_id"]
    assert _post(client, "/api/repertoires/set-active", {"repertoire_id": other, "active": False}).status_code == 200
    r = client.get("/api/analyze/book")
    assert r.status_code == 200, r.text
    reps = r.json()["repertoires"]
    assert [row["id"] for row in reps] == [rep]
    assert {key for key in reps[0]} == {"id", "name", "color", "nodes"}
    nodes = reps[0]["nodes"]
    assert all(set(node) == {"id", "parent_id", "uci", "depth", "is_enabled", "is_mainline"} for node in nodes)
    assert [node["uci"] for node in nodes] == [None, "e2e4", "e7e5", "g1f3"]
    assert nodes[1]["id"] == ids["tmp-1"]
