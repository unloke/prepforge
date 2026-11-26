"""Scout's one-request read of the caller's active repertoire trees."""
from __future__ import annotations

from api_helpers import csrf_headers
from fastapi.testclient import TestClient


def _register(client: TestClient, email: str) -> None:
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1", "display_name": email.split("@")[0]},
        headers=csrf_headers(client),
    )
    assert r.status_code == 201, r.text


def _create(client: TestClient, name: str, color: str) -> dict:
    r = client.post("/api/repertoires/create", json={"name": name, "color": color}, headers=csrf_headers(client))
    assert r.status_code < 300, r.text
    return r.json()


def _add(client: TestClient, rep_id: str, parent_id: str, uci: str) -> str:
    r = client.post(
        "/api/build/add-move",
        json={"repertoire_id": rep_id, "parent_node_id": parent_id, "move_uci": uci},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    return r.json()["selected_node_id"]


def test_scout_trees_requires_auth(client):
    assert client.get("/api/scout/trees").status_code == 401


def test_scout_trees_returns_slim_trees_matching_build_load(client):
    _register(client, "a@example.com")
    white = _create(client, "KP", "white")
    root = white["selected_node_id"]
    e4 = _add(client, white["repertoire_id"], root, "e2e4")
    _add(client, white["repertoire_id"], e4, "e7e5")
    _add(client, white["repertoire_id"], root, "d2d4")
    black = _create(client, "Sicilian", "black")
    off = _create(client, "Old", "black")
    assert client.post(
        "/api/repertoires/set-active", json={"repertoire_id": off["repertoire_id"], "active": False},
        headers=csrf_headers(client),
    ).status_code == 200

    r = client.get("/api/scout/trees")
    assert r.status_code == 200, r.text
    reps = {rep["id"]: rep for rep in r.json()["repertoires"]}
    # Inactive repertoires are left out, as Scout's start-up leaves them out.
    assert set(reps) == {white["repertoire_id"], black["repertoire_id"]}
    assert reps[black["repertoire_id"]]["color"] == "black"
    assert reps[white["repertoire_id"]]["name"] == "KP"

    slim = reps[white["repertoire_id"]]["nodes"]
    assert all(set(node) == {"id", "parent_id", "uci", "depth", "is_enabled", "is_mainline"} for node in slim)
    full = client.get(f"/api/build/load?repertoire_id={white['repertoire_id']}").json()["nodes"]
    keys = ("id", "parent_id", "uci", "depth", "is_enabled", "is_mainline")
    # The same tree, in the same order, as the Build payload carries.
    assert slim == [{k: node[k] for k in keys} for node in full]
    assert slim[0]["depth"] == 0
    assert {(n["uci"], n["depth"]) for n in slim[1:]} == {("e2e4", 1), ("e7e5", 2), ("d2d4", 1)}


def test_scout_trees_is_owner_scoped(client):
    _register(client, "a@example.com")
    _create(client, "Mine", "white")
    from prepforge_chess.api import main

    other = TestClient(main.app)
    _register(other, "b@example.com")
    assert other.get("/api/scout/trees").json() == {"repertoires": []}
