"""Phase 2b-2e: the last SPA Build/import/board endpoints ported off web/server.py.

Covers ``POST /api/build/{action,annotations,export}``,
``POST /api/repertoires/{import,import-pgn}`` and the ``POST /api/board/move``
chess utility. All are pure data/utility ops (no server-side engine), owner-gated
where they touch stored repertoires.
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


def _create_with_move(client: TestClient, name: str = "White e4") -> tuple[str, str, str]:
    """Create a White repertoire and play 1.e4, returning (rep_id, root_id, move_node_id)."""
    create = client.post(
        "/api/repertoires/create",
        json={"name": name, "color": "white"},
        headers=csrf_headers(client),
    ).json()
    rep_id = create["repertoire_id"]
    root_id = create["selected_node_id"]
    moved = client.post(
        "/api/build/add-move",
        json={"repertoire_id": rep_id, "parent_node_id": root_id, "move_uci": "e2e4"},
        headers=csrf_headers(client),
    ).json()
    return rep_id, root_id, moved["selected_node_id"]


# ---- board/move utility -----------------------------------------------------

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def test_board_move_requires_auth(client):
    r = client.post(
        "/api/board/move",
        json={"fen": START_FEN, "move_uci": "e2e4"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 401


def test_board_move_applies_move(client):
    _register(client, "a@example.com")
    r = client.post(
        "/api/board/move",
        json={"fen": START_FEN, "move_uci": "e2e4"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["move"]["uci"] == "e2e4"
    assert body["move"]["san"] == "e4"
    assert body["move"]["fen_before"] == START_FEN
    assert body["board"]["side_to_move"] == "black"
    assert "e7e5" in body["board"]["legal_moves"]


def test_board_move_rejects_illegal_move(client):
    _register(client, "a@example.com")
    r = client.post(
        "/api/board/move",
        json={"fen": START_FEN, "move_uci": "e2e5"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_board_move_rejects_bad_fen(client):
    _register(client, "a@example.com")
    r = client.post(
        "/api/board/move",
        json={"fen": "not a fen", "move_uci": "e2e4"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


# ---- build/action -----------------------------------------------------------


def test_action_requires_csrf(client):
    _register(client, "a@example.com")
    rep_id, _root, node_id = _create_with_move(client)
    r = client.post(
        "/api/build/action",
        json={"repertoire_id": rep_id, "node_id": node_id, "action": "mark_critical"},
    )
    assert r.status_code == 403


def test_action_add_tag_and_comment(client):
    _register(client, "a@example.com")
    rep_id, _root, node_id = _create_with_move(client)

    tagged = client.post(
        "/api/build/action",
        json={"repertoire_id": rep_id, "node_id": node_id, "action": "add_tag", "value": "sharp"},
        headers=csrf_headers(client),
    )
    assert tagged.status_code == 200, tagged.text
    node = next(n for n in tagged.json()["nodes"] if n["id"] == node_id)
    assert "sharp" in node["tags"]

    commented = client.post(
        "/api/build/action",
        json={"repertoire_id": rep_id, "node_id": node_id, "action": "add_comment", "value": "key move"},
        headers=csrf_headers(client),
    )
    assert commented.status_code == 200
    node = next(n for n in commented.json()["nodes"] if n["id"] == node_id)
    assert node["comment"] == "key move"


def test_action_add_tag_without_value_is_400(client):
    _register(client, "a@example.com")
    rep_id, _root, node_id = _create_with_move(client)
    r = client.post(
        "/api/build/action",
        json={"repertoire_id": rep_id, "node_id": node_id, "action": "add_tag"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_action_delete_removes_node(client):
    _register(client, "a@example.com")
    rep_id, root_id, node_id = _create_with_move(client)
    r = client.post(
        "/api/build/action",
        json={"repertoire_id": rep_id, "node_id": node_id, "action": "delete"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["nodes_total"] == 1  # only root remains
    assert all(n["id"] != node_id for n in body["nodes"])
    assert body["selected_node_id"] == root_id


# ---- build/delete-nodes (local-first delete flush) ---------------------------


def _add_move(client: TestClient, rep_id: str, parent_id: str, uci: str) -> str:
    body = client.post(
        "/api/build/add-move",
        json={"repertoire_id": rep_id, "parent_node_id": parent_id, "move_uci": uci},
        headers=csrf_headers(client),
    ).json()
    return body["selected_node_id"]


def _delete_nodes(client: TestClient, rep_id: str, node_ids: list[str]):
    return client.post(
        "/api/build/delete-nodes",
        json={"repertoire_id": rep_id, "node_ids": node_ids},
        headers=csrf_headers(client),
    )


def test_delete_nodes_requires_csrf(client):
    _register(client, "a@example.com")
    rep_id, _root, node_id = _create_with_move(client)
    r = client.post(
        "/api/build/delete-nodes",
        json={"repertoire_id": rep_id, "node_ids": [node_id]},
    )
    assert r.status_code == 403


def test_delete_nodes_removes_whole_subtree(client):
    """Deleting a subtree root removes every descendant; the payload and the
    removed_node_ids echo agree."""
    _register(client, "a@example.com")
    rep_id, _root, e4 = _create_with_move(client)
    e5 = _add_move(client, rep_id, e4, "e7e5")
    nf3 = _add_move(client, rep_id, e5, "g1f3")
    r = _delete_nodes(client, rep_id, [e4])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["nodes_total"] == 1  # only root remains
    assert set(body["removed_node_ids"]) == {e4, e5, nf3}


def test_delete_nodes_is_idempotent_per_id(client):
    """An id already removed (by an earlier subtree in the same batch, or by a
    previous flush) is skipped, not an error — the client over-deletes freely."""
    _register(client, "a@example.com")
    rep_id, _root, e4 = _create_with_move(client)
    e5 = _add_move(client, rep_id, e4, "e7e5")
    # e5 dies twice: as e4's descendant and by its own id; plus a bogus id.
    r = _delete_nodes(client, rep_id, [e4, e5, "no-such-node"])
    assert r.status_code == 200, r.text
    assert set(r.json()["removed_node_ids"]) == {e4, e5}
    # A second flush of the same batch is a no-op.
    again = _delete_nodes(client, rep_id, [e4, e5])
    assert again.status_code == 200
    assert again.json()["removed_node_ids"] == []


def test_delete_nodes_rejects_the_root(client):
    _register(client, "a@example.com")
    rep_id, root_id, _node = _create_with_move(client)
    assert _delete_nodes(client, rep_id, [root_id]).status_code == 400


def test_delete_nodes_caps_batch_size(client):
    _register(client, "a@example.com")
    rep_id, _root, _node = _create_with_move(client)
    too_many = [f"id-{i}" for i in range(201)]
    assert _delete_nodes(client, rep_id, too_many).status_code == 400


def test_delete_nodes_is_owner_gated(client):
    _register(client, "a@example.com", display_name="A")
    rep_id, _root, node_id = _create_with_move(client)
    other = _client()
    _register(other, "b@example.com", display_name="B")
    assert _delete_nodes(other, rep_id, [node_id]).status_code == 404


def test_delete_then_readd_creates_a_fresh_node(client):
    """The client flushes deletes before adds so a replayed move lands as a new
    node instead of deduping against the dying one."""
    _register(client, "a@example.com")
    rep_id, root_id, e4 = _create_with_move(client)
    assert _delete_nodes(client, rep_id, [e4]).status_code == 200
    r = client.post(
        "/api/build/add-moves",
        json={
            "repertoire_id": rep_id,
            "moves": [{"tempId": "tmp-1", "parentRef": root_id, "uci": "e2e4"}],
        },
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    new_id = body["id_map"]["tmp-1"]
    assert new_id != e4
    assert any(n["id"] == new_id and n["uci"] == "e2e4" for n in body["nodes"])


def test_action_unknown_is_400(client):
    _register(client, "a@example.com")
    rep_id, _root, node_id = _create_with_move(client)
    r = client.post(
        "/api/build/action",
        json={"repertoire_id": rep_id, "node_id": node_id, "action": "frobnicate"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_action_is_owner_gated(client):
    _register(client, "a@example.com", display_name="A")
    rep_id, _root, node_id = _create_with_move(client)

    other = _client()
    _register(other, "b@example.com", display_name="B")
    r = other.post(
        "/api/build/action",
        json={"repertoire_id": rep_id, "node_id": node_id, "action": "mark_critical"},
        headers=csrf_headers(other),
    )
    assert r.status_code == 404


# ---- build/annotations ------------------------------------------------------


def test_annotations_persist_and_echo(client):
    _register(client, "a@example.com")
    rep_id, _root, node_id = _create_with_move(client)
    r = client.post(
        "/api/build/annotations",
        json={"repertoire_id": rep_id, "node_id": node_id, "arrows": ["e2e4"], "circles": ["d4"]},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"node_id": node_id, "arrows": ["e2e4"], "circles": ["d4"]}

    # Persisted: the Build payload now carries the annotations.
    load = client.get("/api/build/load", params={"repertoire_id": rep_id}).json()
    node = next(n for n in load["nodes"] if n["id"] == node_id)
    assert node["arrows"] == ["e2e4"]
    assert node["circles"] == ["d4"]


def test_annotations_owner_gated(client):
    _register(client, "a@example.com", display_name="A")
    rep_id, _root, node_id = _create_with_move(client)

    other = _client()
    _register(other, "b@example.com", display_name="B")
    r = other.post(
        "/api/build/annotations",
        json={"repertoire_id": rep_id, "node_id": node_id, "arrows": [], "circles": []},
        headers=csrf_headers(other),
    )
    assert r.status_code == 404


# ---- build/export -----------------------------------------------------------


def test_export_json_and_pgn(client):
    _register(client, "a@example.com")
    rep_id, _root, _node = _create_with_move(client, name="My Sicilian!")

    js = client.post(
        "/api/build/export",
        json={"repertoire_id": rep_id, "format": "json"},
        headers=csrf_headers(client),
    )
    assert js.status_code == 200, js.text
    body = js.json()
    assert body["filename"] == "my-sicilian.prepforge.json"
    assert body["mime"] == "application/json"
    assert body["content"].strip().startswith("{")

    pgn = client.post(
        "/api/build/export",
        json={"repertoire_id": rep_id, "format": "pgn"},
        headers=csrf_headers(client),
    )
    assert pgn.status_code == 200, pgn.text
    assert pgn.json()["filename"] == "my-sicilian.pgn"
    assert "e4" in pgn.json()["content"]


def test_export_bad_format_is_400(client):
    _register(client, "a@example.com")
    rep_id, _root, _node = _create_with_move(client)
    r = client.post(
        "/api/build/export",
        json={"repertoire_id": rep_id, "format": "docx"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_export_owner_gated(client):
    _register(client, "a@example.com", display_name="A")
    rep_id, _root, _node = _create_with_move(client)

    other = _client()
    _register(other, "b@example.com", display_name="B")
    r = other.post(
        "/api/build/export",
        json={"repertoire_id": rep_id, "format": "json"},
        headers=csrf_headers(other),
    )
    assert r.status_code == 404


def test_export_tree_pgn(client):
    _register(client, "a@example.com")
    rep_id, _root, _node = _create_with_move(client, name="Tree Rep")
    r = client.get("/api/repertoires/export-pgn", params={"repertoire_id": rep_id})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filename"] == "tree-rep.tree.pgn"
    assert body["mime"] == "application/x-chess-pgn"
    assert "e4" in body["content"]


def test_export_tree_pgn_owner_gated(client):
    _register(client, "a@example.com", display_name="A")
    rep_id, _root, _node = _create_with_move(client)

    other = _client()
    _register(other, "b@example.com", display_name="B")
    r = other.get("/api/repertoires/export-pgn", params={"repertoire_id": rep_id})
    assert r.status_code == 404


# ---- repertoires/import (package json) --------------------------------------


def test_import_json_round_trip_and_claims_owner(client):
    _register(client, "a@example.com")
    rep_id, _root, _node = _create_with_move(client, name="Export Me")
    package = client.post(
        "/api/build/export",
        json={"repertoire_id": rep_id, "format": "json"},
        headers=csrf_headers(client),
    ).json()["content"]

    r = client.post(
        "/api/repertoires/import",
        json={"package_json": package},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "Export Me"
    assert body["nodes_total"] == 2  # root + e4
    assert body["summary"]["added_nodes"] == 2


def test_import_empty_package_is_400(client):
    _register(client, "a@example.com")
    r = client.post(
        "/api/repertoires/import",
        json={"package_json": "   "},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_imported_repertoire_is_owner_isolated(client):
    _register(client, "a@example.com")
    rep_id, _root, _node = _create_with_move(client, name="Mine")
    package = client.post(
        "/api/build/export",
        json={"repertoire_id": rep_id, "format": "json"},
        headers=csrf_headers(client),
    ).json()["content"]

    other = _client()
    _register(other, "b@example.com")
    imported = other.post(
        "/api/repertoires/import",
        json={"package_json": package},
        headers=csrf_headers(other),
    ).json()

    # B's import is B's; A does not see it in their list.
    a_reps = {r["id"] for r in client.get("/api/repertoires").json()["repertoires"]}
    assert imported["repertoire_id"] not in a_reps
    b_reps = {r["id"] for r in other.get("/api/repertoires").json()["repertoires"]}
    assert imported["repertoire_id"] in b_reps


# ---- repertoires/import-pgn -------------------------------------------------


def test_import_pgn_creates_repertoire(client):
    _register(client, "a@example.com")
    r = client.post(
        "/api/repertoires/import-pgn",
        json={"pgn": "1. e4 e5 2. Nf3 *", "name": "King Pawn", "color": "white"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "King Pawn"
    assert body["color"] == "white"
    assert body["nodes_total"] >= 3  # root + e4 + e5 + Nf3


def test_import_pgn_rejects_bad_color(client):
    _register(client, "a@example.com")
    r = client.post(
        "/api/repertoires/import-pgn",
        json={"pgn": "1. e4 *", "name": "X", "color": "green"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400
