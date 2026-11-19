"""Inverse edits must preserve subsequent work and the access boundary."""
import test_repertoire_access as access
from test_repertoire_access import _post, _load

world = access.world


def _edit(w, who, value):
    result = _post(w["c"][who], "/api/build/action", {
        "repertoire_id": w["rep"], "node_id": w["e4"], "action": "add_comment", "value": value,
    })
    assert result.status_code == 200, result.text
    return result.json()["revision"]


def _revert(w, rev, who="owner"):
    return _post(w["c"][who], "/api/build/activity/revert", {"repertoire_id": w["rep"], "revision": rev})


def test_activity_authors_and_unread_cursor_are_per_user(world):
    w = world
    rev = _edit(w, "edit", "Compare c5")
    url = f'/api/build/activity?repertoire_id={w["rep"]}'
    body = w["c"]["owner"].get(url).json()
    assert body["entries"][0]["actor"] == "Edit"
    assert body["entries"][0]["created_at"]
    assert w["e4"] in body["unread_nodes"]
    assert _post(w["c"]["owner"], "/api/build/activity/seen", {"repertoire_id": w["rep"], "revision": rev}).status_code == 200
    assert w["c"]["owner"].get(url).json()["unread_nodes"] == []
    assert w["c"]["view"].get(url).json()["entries"][0]["unread"]
    assert w["c"]["outsider"].get(url).status_code == 404
    assert _revert(w, rev, "edit").status_code == 403
    assert _revert(w, rev, "outsider").status_code == 404


def test_inverse_only_touches_its_fields_and_refuses_a_newer_edit(world):
    w = world
    rev = _edit(w, "edit", "Compare c5")
    assert _post(w["c"]["owner"], "/api/build/annotations", {
        "repertoire_id": w["rep"], "node_id": w["e4"], "arrows": ["e7e5"],
    }).status_code == 200
    undone = _revert(w, rev)
    assert undone.status_code == 200, undone.text
    node = next(n for n in undone.json()["nodes"] if n["id"] == w["e4"])
    assert not node["comment"]
    assert node["arrows"] == ["e7e5"]
    assert _revert(w, rev).status_code == 409
    original = _edit(w, "edit", "first")
    _edit(w, "owner", "later")
    assert _revert(w, original).status_code == 409
    node = next(n for n in _load(w["c"]["owner"], w["rep"]).json()["nodes"] if n["id"] == w["e4"])
    assert node["comment"] == "later"


def test_inverse_addition_does_not_cascade_a_later_continuation(world):
    w = world
    moved = _post(w["c"]["edit"], "/api/build/add-move", {"repertoire_id": w["rep"], "parent_node_id": w["e4"], "move_uci": "e7e5"}).json()
    e5 = moved["selected_node_id"]
    _post(w["c"]["owner"], "/api/build/add-move", {"repertoire_id": w["rep"], "parent_node_id": e5, "move_uci": "g1f3"})
    assert _revert(w, moved["revision"]).status_code == 409


def test_deleted_tree_is_restored_in_parent_order(world):
    w = world
    _edit(w, "edit", "Keep this note")
    moved = _post(w["c"]["edit"], "/api/build/add-move", {"repertoire_id": w["rep"], "parent_node_id": w["e4"], "move_uci": "e7e5"}).json()
    deleted = _post(w["c"]["edit"], "/api/build/delete-nodes", {"repertoire_id": w["rep"], "node_ids": [w["e4"]]}).json()
    undone = _revert(w, deleted["revision"])
    assert undone.status_code == 200, undone.text
    nodes = {n["id"]: n for n in undone.json()["nodes"]}
    assert nodes[w["e4"]]["comment"] == "Keep this note"
    assert moved["selected_node_id"] in nodes
    assert _revert(w, deleted["revision"]).status_code == 409


def test_revert_restores_compact_op_delta_and_cleans_up_generated_adds(world):
    import json
    from sqlalchemy import select
    from prepforge_chess.api import db
    from prepforge_chess.storage import sa_tables

    w = world
    plan = {
        "rootNodeId": w["e4"],
        "changes": [
            {
                "action": "planned_add",
                "tempId": "tmp-1",
                "parentRef": w["e4"],
                "moveUci": "e7e5",
                "source": "generated_maia3",
                "intendedMainline": True,
                "maiaProbability": 0.42,
                "engineEvaluation": {
                    "engine": "stockfish",
                    "depth": 8,
                    "score_cp": 25,
                    "mate_in": None,
                    "best_move_uci": "g1f3",
                    "pv": ["e7e5"],
                },
            }
        ],
    }
    applied = _post(w["c"]["owner"], "/api/build/generate/apply-plan", {
        "repertoire_id": w["rep"], "root_node_id": w["e4"], "plan": plan,
    })
    assert applied.status_code == 200, applied.text
    app_body = applied.json()
    e5_node = next(n for n in app_body["nodes"] if n["uci"] == "e7e5")

    # Compact op omits default fields like comment/tags_json and redundant repertoire_id
    with db.make_engine().connect() as conn:
        encoded = conn.scalar(select(sa_tables.repertoire_ops.c.op_json).where(
            sa_tables.repertoire_ops.c.repertoire_id == w["rep"],
            sa_tables.repertoire_ops.c.revision == app_body["revision"],
        ))
    delta_entry = json.loads(encoded)["delta"][e5_node["id"]]
    assert delta_entry["before"] is None
    assert "repertoire_id" not in delta_entry["after"]
    assert "tags_json" not in delta_entry["after"]

    # Deleting and reverting must expand defaults + restore eval/prob intact
    deleted = _post(w["c"]["edit"], "/api/build/delete-nodes", {
        "repertoire_id": w["rep"], "node_ids": [e5_node["id"]],
    })
    assert deleted.status_code == 200, deleted.text
    restored = _revert(w, deleted.json()["revision"])
    assert restored.status_code == 200, restored.text
    restored_e5 = next(n for n in restored.json()["nodes"] if n["id"] == e5_node["id"])
    assert restored_e5["maia_probability"] == 0.42
    assert restored_e5["engine_evaluation"]["score_cp"] == 25
    assert restored_e5["source"] == "generated_maia3"
    assert restored_e5["is_enabled"] is True

    # Delete the restored node again so undo-delete stays verified cleanly without conflict on app rev
    _post(w["c"]["owner"], "/api/build/action", {
        "repertoire_id": w["rep"], "node_id": w["e4"], "action": "add_comment", "value": "x",
    })
    applied2 = _post(w["c"]["owner"], "/api/build/generate/apply-plan", {
        "repertoire_id": w["rep"], "root_node_id": e5_node["id"],
        "plan": {
            "rootNodeId": e5_node["id"],
            "changes": [{
                "action": "planned_add", "tempId": "tmp-2", "parentRef": e5_node["id"],
                "moveUci": "g1f3", "source": "generated_stockfish", "intendedMainline": True,
            }],
        },
    })
    assert applied2.status_code == 200, applied2.text
    reverted_add = _revert(w, applied2.json()["revision"])
    assert reverted_add.status_code == 200, reverted_add.text
    assert all(n["uci"] != "g1f3" for n in reverted_add.json()["nodes"])
