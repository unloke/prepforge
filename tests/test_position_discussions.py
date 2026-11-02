import test_repertoire_access as access
from test_repertoire_access import _post, _load

world = access.world


def _start(w, who="view", **fields):
    fen = next(n["fen"] for n in _load(w["c"]["owner"], w["rep"]).json()["nodes"] if n["id"] == w["e4"])
    return _post(w["c"][who], "/api/build/discussions", {"repertoire_id": w["rep"], "fen": fen, "body": "Why not c5?", **fields})


def _list(w, who="owner"):
    return w["c"][who].get(f'/api/build/discussions?repertoire_id={w["rep"]}')


def test_discussions_are_scoped_to_access_and_survive_deleted_nodes(world):
    w = world
    started = _start(w)
    assert started.status_code == 200, started.text
    tid = started.json()["thread_id"]
    assert _list(w).json()["threads"][0]["node_id"] == w["e4"]
    assert _list(w, "outsider").status_code == 404
    assert _start(w, "outsider").status_code == 404
    deleted = _post(w["c"]["edit"], "/api/build/delete-nodes", {"repertoire_id": w["rep"], "node_ids": [w["e4"]]})
    assert deleted.status_code == 200
    thread = _list(w).json()["threads"][0]
    assert thread["node_id"] is None
    assert thread["messages"][0]["body"] == "Why not c5?"
    assert _post(w["c"]["edit"], "/api/build/discussions", {"repertoire_id": w["rep"], "thread_id": tid, "body": "We can restore this line."}).status_code == 200
    activity = w["c"]["owner"].get(f'/api/build/activity?repertoire_id={w["rep"]}').json()
    assert activity["entries"][0]["discussion_id"] == tid


def test_counters_and_irrelevant_en_passant_do_not_split_a_position(world):
    w = world
    first = _start(w).json()["thread_id"]
    fen = _list(w).json()["threads"][0]["fen"].split()
    # e3 is not capturable after 1.e4, so both FEN forms name the same position.
    fen[3], fen[4], fen[5] = "e3", "12", "8"
    same = _start(w, fen=" ".join(fen))
    assert same.status_code == 200, same.text
    assert same.json()["thread_id"] == first
    assert len(_list(w).json()["threads"]) == 1
    assert len(_list(w).json()["threads"][0]["messages"]) == 2


def test_resolve_and_reanchor_permissions(world):
    w = world
    tid = _start(w).json()["thread_id"]
    body = {"repertoire_id": w["rep"], "thread_id": tid, "resolved": True}
    assert _post(w["c"]["copy"], "/api/build/discussions/update", body).status_code == 403
    assert _post(w["c"]["view"], "/api/build/discussions/update", body).status_code == 200
    root = next(n["fen"] for n in _load(w["c"]["owner"], w["rep"]).json()["nodes"] if n["id"] == w["root"])
    body = {"repertoire_id": w["rep"], "thread_id": tid, "fen": root}
    assert _post(w["c"]["view"], "/api/build/discussions/update", body).status_code == 403
    assert _post(w["c"]["edit"], "/api/build/discussions/update", body).status_code == 200
    assert _list(w).json()["threads"][0]["node_id"] == w["root"]
    assert _start(w, body="   ").status_code == 422
    assert _start(w, fen="invalid").status_code == 422


def test_thread_id_does_not_grant_access_to_another_repertoire(world):
    w = world
    tid = _start(w).json()["thread_id"]
    other = _post(w["c"]["owner"], "/api/repertoires/create", {"name": "Separate", "color": "black"}).json()["repertoire_id"]
    r = _post(w["c"]["owner"], "/api/build/discussions", {"repertoire_id": other, "thread_id": tid, "body": "leak?"})
    assert r.status_code == 404
