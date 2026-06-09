"""Phase 2b-2d-ii: ported Build-Generate apply-plan endpoint (browser-compute).

The Build view runs the whole generation recursion (Stockfish + Maia3) in the
browser and submits a tree-mutation plan; ``POST /api/build/generate/apply-plan``
runs NO engine — it re-validates legality + parentage, recomputes the persisted
flags, and persists all-or-nothing. The *server-engine* variants (`/generate`,
`/start`, `/cancel`) are deliberately dropped. Same strangler wiring as the other
workspace tests: FastAPI user -> ``current_owner`` bridge -> SQLAlchemy repo.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from api_helpers import csrf_headers


def _register(client: TestClient, email: str, *, display_name: str | None = None) -> str:
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1", "display_name": display_name},
        headers=csrf_headers(client),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _client() -> TestClient:
    from prepforge_chess.api import main

    return TestClient(main.app)


def _create_repertoire(client: TestClient, color: str = "white") -> dict:
    r = client.post(
        "/api/repertoires/create",
        json={"name": "Test", "color": color},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _apply_plan(client: TestClient, repertoire_id: str, root_node_id: str, changes: list) -> "object":
    return client.post(
        "/api/build/generate/apply-plan",
        json={
            "repertoire_id": repertoire_id,
            "root_node_id": root_node_id,
            "plan": {"rootNodeId": root_node_id, "changes": changes},
        },
        headers=csrf_headers(client),
    )


# ---- gating ----------------------------------------------------------------


def test_apply_plan_requires_csrf(client):
    _register(client, "a@example.com")
    rep = _create_repertoire(client)
    r = client.post(
        "/api/build/generate/apply-plan",
        json={"repertoire_id": rep["repertoire_id"], "root_node_id": rep["selected_node_id"],
              "plan": {"changes": []}},
    )
    assert r.status_code == 403


def test_apply_plan_requires_auth(client):
    r = client.post(
        "/api/build/generate/apply-plan",
        json={"repertoire_id": "x", "root_node_id": "y", "plan": {"changes": []}},
        headers=csrf_headers(client),
    )
    assert r.status_code == 401


def test_apply_plan_is_owner_gated(client):
    _register(client, "a@example.com", display_name="A")
    rep = _create_repertoire(client)

    other = _client()
    _register(other, "b@example.com", display_name="B")
    r = _apply_plan(other, rep["repertoire_id"], rep["selected_node_id"], [])
    assert r.status_code == 404


# ---- happy path ------------------------------------------------------------


def test_apply_plan_adds_planned_nodes(client):
    _register(client, "a@example.com")
    rep = _create_repertoire(client)
    root = rep["selected_node_id"]
    # e4 (own move, stockfish), then ...e5 (opponent reply, maia) parented on the
    # same-run tempId so the forward pass resolves it.
    changes = [
        {"action": "planned_add", "tempId": "tmp-1", "parentRef": root, "moveUci": "e2e4",
         "source": "generated_stockfish", "intendedMainline": True},
        {"action": "planned_add", "tempId": "tmp-2", "parentRef": "tmp-1", "moveUci": "e7e5",
         "source": "generated_maia3", "maiaProbability": 0.42, "intendedMainline": True},
    ]
    r = _apply_plan(client, rep["repertoire_id"], root, changes)
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["summary"]["added_nodes"] == 2
    sans = {node["san"] for node in payload["nodes"]}
    assert {"e4", "e5"} <= sans

    # Persisted: a fresh build/load shows the two new nodes.
    loaded = client.get("/api/build/load", params={"repertoire_id": rep["repertoire_id"]}).json()
    assert {"e4", "e5"} <= {node["san"] for node in loaded["nodes"]}


def test_apply_plan_empty_changes_is_noop(client):
    _register(client, "a@example.com")
    rep = _create_repertoire(client)
    r = _apply_plan(client, rep["repertoire_id"], rep["selected_node_id"], [])
    assert r.status_code == 200, r.text
    assert r.json()["summary"]["added_nodes"] == 0


# ---- validation (malformed plan -> 400, nothing persisted) -----------------


def test_apply_plan_rejects_missing_plan(client):
    _register(client, "a@example.com")
    rep = _create_repertoire(client)
    r = client.post(
        "/api/build/generate/apply-plan",
        json={"repertoire_id": rep["repertoire_id"], "root_node_id": rep["selected_node_id"]},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_apply_plan_rejects_illegal_move(client):
    _register(client, "a@example.com")
    rep = _create_repertoire(client)
    root = rep["selected_node_id"]
    changes = [
        {"action": "planned_add", "tempId": "tmp-1", "parentRef": root, "moveUci": "e2e5",
         "source": "generated_stockfish"},
    ]
    r = _apply_plan(client, rep["repertoire_id"], root, changes)
    assert r.status_code == 400


def test_apply_plan_rejects_non_generated_source(client):
    """An untrusted plan may only add generated moves — never inject a MANUAL
    authorship that would dodge the protected-source guards."""
    _register(client, "a@example.com")
    rep = _create_repertoire(client)
    root = rep["selected_node_id"]
    changes = [
        {"action": "planned_add", "tempId": "tmp-1", "parentRef": root, "moveUci": "e2e4",
         "source": "manual"},
    ]
    r = _apply_plan(client, rep["repertoire_id"], root, changes)
    assert r.status_code == 400


def test_apply_plan_rejects_root_node_mismatch(client):
    _register(client, "a@example.com")
    rep = _create_repertoire(client)
    root = rep["selected_node_id"]
    # plan.rootNodeId disagrees with the request's root_node_id -> reject, never guess.
    r = client.post(
        "/api/build/generate/apply-plan",
        json={
            "repertoire_id": rep["repertoire_id"],
            "root_node_id": root,
            "plan": {"rootNodeId": "some-other-node", "changes": []},
        },
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_apply_plan_unknown_root_node_is_400(client):
    _register(client, "a@example.com")
    rep = _create_repertoire(client)
    r = _apply_plan(client, rep["repertoire_id"], "does-not-exist", [])
    assert r.status_code == 400
