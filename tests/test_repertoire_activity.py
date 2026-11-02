"""Inverse edits must preserve subsequent work and the access boundary."""
from test_repertoire_access import world, _post, _load  # noqa: F401


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
