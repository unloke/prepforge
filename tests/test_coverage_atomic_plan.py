"""Coverage virtual-anchor plans use the production apply-plan API."""
import uuid

from api_helpers import csrf_headers
from test_api_workspace import _register


def _fixture(client):
    _register(client, "coverage@example.com")
    created = client.post("/api/repertoires/create", headers=csrf_headers(client),
                          json={"name": "Coverage", "color": "white"}).json()
    root = created["selected_node_id"]
    response = client.post("/api/build/add-move", headers=csrf_headers(client), json={
        "repertoire_id": created["repertoire_id"], "parent_node_id": root, "move_uci": "e2e4",
    })
    assert response.status_code == 200, response.text
    added = response.json()
    return {"repertoire_id": added["repertoire_id"], "root_node_id": root,
            "base_revision": added["revision"], "operation_id": str(uuid.uuid4()),
            "plan": {"rootNodeId": root, "changes": [
                {"action": "planned_add", "tempId": "tmp-opponent",
                 "parentRef": added["selected_node_id"], "moveUci": "e7e5",
                 "source": "generated_maia3", "intendedMainline": False, "maiaProbability": 0.7},
                {"action": "planned_add", "tempId": "tmp-reply", "parentRef": "tmp-opponent",
                 "moveUci": "g1f3", "source": "generated_stockfish", "intendedMainline": True},
            ]}}


def test_coverage_reply_and_opponent_commit_together_and_retry_once(client):
    request = _fixture(client)
    first = client.post("/api/build/generate/apply-plan", headers=csrf_headers(client), json=request)
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["summary"]["added_nodes"] == 2
    reply = next(n for n in payload["nodes"] if n["uci"] == "g1f3")
    assert reply["is_prepared"] is True
    assert payload["id_map"]["tmp-reply"] == reply["id"]
    replay = client.post("/api/build/generate/apply-plan", headers=csrf_headers(client), json=request)
    assert replay.status_code == 200, replay.text
    assert replay.json()["revision"] == payload["revision"]
    assert replay.json()["summary"] == payload["summary"]
    assert replay.json()["id_map"] == payload["id_map"]
    practice = client.post("/api/train/smart/start", headers=csrf_headers(client), json={
        "repertoire_id": request["repertoire_id"], "target_node_ids": [reply["id"]],
        "session_size": 4, "new_cap": 0,
    })
    assert practice.status_code == 200, practice.text
    assert any(target["node_id"] == reply["id"]
               for card in practice.json()["cards"] for target in card["targets"])
    assert len(replay.json()["nodes"]) == 4
    request["plan"]["changes"][1]["moveUci"] = "b1c3"
    conflict = client.post("/api/build/generate/apply-plan", headers=csrf_headers(client), json=request)
    assert conflict.status_code == 409


def test_invalid_own_reply_cannot_leave_only_an_opponent_node(client):
    request = _fixture(client)
    request["plan"]["changes"][1]["moveUci"] = "e7e6"
    response = client.post("/api/build/generate/apply-plan", headers=csrf_headers(client), json=request)
    assert response.status_code == 400
    loaded = client.get("/api/build/load", params={"repertoire_id": request["repertoire_id"]}).json()
    assert len(loaded["nodes"]) == 2
    assert loaded["revision"] == request["base_revision"]
