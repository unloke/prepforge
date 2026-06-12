"""Phase 2b: ported read-only workspace endpoints + the identity bridge.

Proves the strangler wiring end-to-end: a FastAPI email/password ``User`` ->
``current_owner`` bridge (profile id == user id) -> SQLAlchemy repository ->
owner-scoped data, with no legacy ``request_lock``.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from api_helpers import csrf_headers


def _register(client: TestClient, email: str, *, display_name: str | None = None) -> str:
    """Register a user on ``client`` (leaving it logged in) and return the user id."""
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


def _seed_repertoire(owner_user_id: str, name: str) -> str:
    """Persist one repertoire owned by ``owner_user_id`` on the app's shared engine
    (the repertoire-create endpoint is a later write-path slice; this stands in)."""
    import uuid

    from prepforge_chess.api.db import get_engine
    from prepforge_chess.core.models import Color, OpeningNode, Repertoire
    from prepforge_chess.storage.repositories import PrepForgeRepository

    rep_id = uuid.uuid4().hex
    start_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    rep = Repertoire(
        id=rep_id,
        name=name,
        color=Color.WHITE,
        root_fen=start_fen,
        root_node=OpeningNode(
            id=uuid.uuid4().hex,
            repertoire_id=rep_id,
            fen=start_fen,
            side_to_move=Color.WHITE,
            is_mainline=True,
        ),
    )
    repo = PrepForgeRepository(get_engine())
    repo.ensure_profile(owner_user_id, display_name="seed")
    repo.save_repertoire(rep, owner_user_id=owner_user_id)
    return rep.id


# ---- Auth gating -----------------------------------------------------------


def test_workspace_reads_require_auth(client):
    assert client.get("/api/dashboard").status_code == 401
    assert client.get("/api/repertoires").status_code == 401


def test_auth_status_signed_out(client):
    r = client.get("/api/auth/status")
    assert r.status_code == 200
    assert r.json() == {"signed_in": False, "username": None}


# ---- Happy path ------------------------------------------------------------


def test_new_user_sees_empty_owner_scoped_workspace(client):
    _register(client, "coach@example.com", display_name="Coach")

    dash = client.get("/api/dashboard")
    assert dash.status_code == 200, dash.text
    body = dash.json()
    assert body["games"] == 0
    assert body["repertoires"] == 0
    assert body["training_sessions"] == 0
    assert body["open_mistakes"] == 0
    assert body["due_reviews"] == 0
    assert len(body["recommendations"]) == 3
    # Weekly recap: empty but well-formed for a brand-new user.
    recap = body["recap"]
    assert recap["reviews_7d"] == 0
    assert recap["mastered_now"] == 0 and recap["mastered_delta"] == 0
    assert recap["weak_now"] == 0 and recap["weak_delta"] == 0
    assert recap["week_start"]

    reps = client.get("/api/repertoires")
    assert reps.status_code == 200
    assert reps.json() == {"repertoires": [], "shared": []}


def test_dashboard_recap_counts_this_weeks_reviews(client):
    """The recap counts progress rows touched in the last 7 days; the week-start
    snapshot keeps deltas at zero until mastery actually moves."""
    _register(client, "coach@example.com", display_name="Coach")
    client.get("/api/dashboard")  # snapshot at zero

    created = client.post(
        "/api/repertoires/create",
        json={"name": "KP", "color": "white"},
        headers=csrf_headers(client),
    ).json()
    client.post(
        "/api/build/add-move",
        json={
            "repertoire_id": created["repertoire_id"],
            "parent_node_id": created["selected_node_id"],
            "move_uci": "e2e4",
        },
        headers=csrf_headers(client),
    )
    start = client.post(
        "/api/train/smart/start",
        json={"repertoire_id": created["repertoire_id"], "seed": 5},
        headers=csrf_headers(client),
    ).json()
    client.post(
        "/api/train/smart/move",
        json={"session_id": start["session_id"], "played_uci": "e2e4", "attempt": 1},
        headers=csrf_headers(client),
    )

    recap = client.get("/api/dashboard").json()["recap"]
    assert recap["reviews_7d"] == 1
    # One correct attempt is not mastery yet; nothing weak either.
    assert recap["mastered_now"] == 0 and recap["mastered_delta"] == 0
    assert recap["weak_now"] == 0 and recap["weak_delta"] == 0


def test_auth_status_signed_in_reports_display_name(client):
    _register(client, "coach@example.com", display_name="Coach")
    r = client.get("/api/auth/status")
    assert r.status_code == 200
    assert r.json() == {"signed_in": True, "username": "Coach"}


def test_auth_status_falls_back_to_email(client):
    _register(client, "noname@example.com", display_name=None)
    assert client.get("/api/auth/status").json()["username"] == "noname@example.com"


# ---- Owner isolation (the bridge passes the right owner) --------------------


def test_repertoires_isolated_between_users(client):
    user_a = _register(client, "a@example.com", display_name="A")
    # Touch an owned endpoint so the bridge materializes A's profile, then seed.
    assert client.get("/api/dashboard").status_code == 200
    _seed_repertoire(user_a, "A's London")

    a_reps = client.get("/api/repertoires").json()["repertoires"]
    assert [r["name"] for r in a_reps] == ["A's London"]
    assert client.get("/api/dashboard").json()["repertoires"] == 1

    other = _client()
    _register(other, "b@example.com", display_name="B")
    assert other.get("/api/repertoires").json() == {"repertoires": [], "shared": []}
    assert other.get("/api/dashboard").json()["repertoires"] == 0


# ---- Build view (2b-2b: Maia-free workspace payload) -----------------------


def test_build_load_requires_auth(client):
    assert client.get("/api/build/load?repertoire_id=x").status_code == 401


def test_build_load_returns_workspace_payload(client):
    owner = _register(client, "a@example.com", display_name="A")
    assert client.get("/api/dashboard").status_code == 200
    rep_id = _seed_repertoire(owner, "A's London")

    r = client.get(f"/api/build/load?repertoire_id={rep_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["repertoire_id"] == rep_id
    assert body["name"] == "A's London"
    assert body["color"] == "white"
    # A freshly-seeded repertoire is just its root node.
    assert body["selected_node_id"] == body["nodes"][0]["id"]
    assert body["nodes_total"] == 1
    assert len(body["nodes"]) == 1
    assert body["nodes"][0]["san"] == "root"
    assert "health" in body and "mastery_pct" in body["health"]


def test_build_load_is_owner_gated(client):
    owner = _register(client, "a@example.com", display_name="A")
    assert client.get("/api/dashboard").status_code == 200
    rep_id = _seed_repertoire(owner, "A's London")

    other = _client()
    _register(other, "b@example.com", display_name="B")
    assert other.get(f"/api/build/load?repertoire_id={rep_id}").status_code == 404


# ---- Repertoire mutations (2b-2a: write path) ------------------------------


def test_delete_requires_csrf(client):
    _register(client, "coach@example.com")
    # No X-CSRF-Token header -> rejected by the CSRF middleware before the handler.
    r = client.post("/api/repertoires/delete", json={"repertoire_id": "x"})
    assert r.status_code == 403


def test_delete_requires_auth(client):
    # Valid CSRF but no session -> the owner dependency rejects it.
    r = client.post(
        "/api/repertoires/delete",
        json={"repertoire_id": "x"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 401


def test_delete_own_repertoire(client):
    owner = _register(client, "a@example.com", display_name="A")
    assert client.get("/api/dashboard").status_code == 200
    rep_id = _seed_repertoire(owner, "A's London")
    assert client.get("/api/dashboard").json()["repertoires"] == 1

    r = client.post(
        "/api/repertoires/delete",
        json={"repertoire_id": rep_id},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200
    assert r.json() == {"deleted": rep_id}
    assert client.get("/api/repertoires").json() == {"repertoires": [], "shared": []}
    assert client.get("/api/dashboard").json()["repertoires"] == 0


def test_cannot_delete_another_users_repertoire(client):
    owner = _register(client, "a@example.com", display_name="A")
    assert client.get("/api/dashboard").status_code == 200
    rep_id = _seed_repertoire(owner, "A's London")

    other = _client()
    _register(other, "b@example.com", display_name="B")
    r = other.post(
        "/api/repertoires/delete",
        json={"repertoire_id": rep_id},
        headers=csrf_headers(other),
    )
    assert r.status_code == 404  # foreign repertoire is not-found, not forbidden
    # A's repertoire survives B's attempt.
    assert [x["id"] for x in client.get("/api/repertoires").json()["repertoires"]] == [rep_id]


def test_set_active_toggles_and_is_owner_gated(client):
    owner = _register(client, "a@example.com", display_name="A")
    assert client.get("/api/dashboard").status_code == 200
    rep_id = _seed_repertoire(owner, "A's London")  # seeded is_active=True

    r = client.post(
        "/api/repertoires/set-active",
        json={"repertoire_id": rep_id, "active": False},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200
    assert r.json() == {"id": rep_id, "name": "A's London", "is_active": False}
    # The flag round-trips through the list read.
    reps = client.get("/api/repertoires").json()["repertoires"]
    assert reps[0]["is_active"] is False

    other = _client()
    _register(other, "b@example.com", display_name="B")
    r = other.post(
        "/api/repertoires/set-active",
        json={"repertoire_id": rep_id, "active": True},
        headers=csrf_headers(other),
    )
    assert r.status_code == 404


# ---- Build write path (2b-2c: create / rename / add-move) -------------------


def test_create_requires_csrf(client):
    _register(client, "coach@example.com")
    r = client.post("/api/repertoires/create", json={"name": "X", "color": "white"})
    assert r.status_code == 403


def test_create_requires_auth(client):
    r = client.post(
        "/api/repertoires/create",
        json={"name": "X", "color": "white"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 401


def test_create_returns_build_payload_and_claims_ownership(client):
    _register(client, "a@example.com", display_name="A")
    assert client.get("/api/dashboard").status_code == 200

    r = client.post(
        "/api/repertoires/create",
        json={"name": "My London", "color": "white"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "My London"
    assert body["color"] == "white"
    # Fresh repertoire is just its root node, and that root is selected.
    assert body["nodes_total"] == 1
    assert body["selected_node_id"] == body["nodes"][0]["id"]
    rep_id = body["repertoire_id"]

    # Claimed for the caller: it shows in their list + dashboard counter.
    reps = client.get("/api/repertoires").json()["repertoires"]
    assert [x["id"] for x in reps] == [rep_id]
    assert client.get("/api/dashboard").json()["repertoires"] == 1


def test_create_blank_name_defaults(client):
    _register(client, "a@example.com")
    r = client.post(
        "/api/repertoires/create",
        json={"name": "   ", "color": "black"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Untitled repertoire"
    assert body["color"] == "black"


def test_create_rejects_bad_color(client):
    _register(client, "a@example.com")
    r = client.post(
        "/api/repertoires/create",
        json={"name": "X", "color": "purple"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_created_repertoire_is_owner_isolated(client):
    _register(client, "a@example.com", display_name="A")
    rep_id = client.post(
        "/api/repertoires/create",
        json={"name": "A's", "color": "white"},
        headers=csrf_headers(client),
    ).json()["repertoire_id"]

    other = _client()
    _register(other, "b@example.com", display_name="B")
    assert other.get("/api/repertoires").json() == {"repertoires": [], "shared": []}
    # B cannot rename or add to A's repertoire (foreign -> 404).
    assert other.post(
        "/api/build/rename",
        json={"repertoire_id": rep_id, "name": "stolen"},
        headers=csrf_headers(other),
    ).status_code == 404


def test_rename_updates_and_returns_payload(client):
    _register(client, "a@example.com")
    rep_id = client.post(
        "/api/repertoires/create",
        json={"name": "Old", "color": "white"},
        headers=csrf_headers(client),
    ).json()["repertoire_id"]

    r = client.post(
        "/api/build/rename",
        json={"repertoire_id": rep_id, "name": "New Name"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "New Name"
    assert client.get("/api/repertoires").json()["repertoires"][0]["name"] == "New Name"


def test_rename_rejects_empty_name(client):
    _register(client, "a@example.com")
    rep_id = client.post(
        "/api/repertoires/create",
        json={"name": "Old", "color": "white"},
        headers=csrf_headers(client),
    ).json()["repertoire_id"]

    r = client.post(
        "/api/build/rename",
        json={"repertoire_id": rep_id, "name": "   "},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_add_move_appends_prepared_move(client):
    _register(client, "a@example.com")
    create = client.post(
        "/api/repertoires/create",
        json={"name": "White e4", "color": "white"},
        headers=csrf_headers(client),
    ).json()
    rep_id = create["repertoire_id"]
    root_id = create["selected_node_id"]

    r = client.post(
        "/api/build/add-move",
        json={"repertoire_id": rep_id, "parent_node_id": root_id, "move_uci": "e2e4"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["nodes_total"] == 2
    assert body["summary"]["added_nodes"] == 1
    new_node = next(n for n in body["nodes"] if n["id"] == body["selected_node_id"])
    assert new_node["uci"] == "e2e4"
    assert new_node["san"] == "e4"
    # White's move in a White repertoire is a prepared move and the new mainline.
    assert new_node["is_prepared"] is True
    assert new_node["is_mainline"] is True
    assert "prepared" in new_node["tags"]


def test_add_move_rejects_illegal_move(client):
    _register(client, "a@example.com")
    create = client.post(
        "/api/repertoires/create",
        json={"name": "X", "color": "white"},
        headers=csrf_headers(client),
    ).json()

    r = client.post(
        "/api/build/add-move",
        json={
            "repertoire_id": create["repertoire_id"],
            "parent_node_id": create["selected_node_id"],
            "move_uci": "e2e5",
        },
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_add_move_is_owner_gated(client):
    _register(client, "a@example.com", display_name="A")
    create = client.post(
        "/api/repertoires/create",
        json={"name": "A's", "color": "white"},
        headers=csrf_headers(client),
    ).json()

    other = _client()
    _register(other, "b@example.com", display_name="B")
    r = other.post(
        "/api/build/add-move",
        json={
            "repertoire_id": create["repertoire_id"],
            "parent_node_id": create["selected_node_id"],
            "move_uci": "e2e4",
        },
        headers=csrf_headers(other),
    )
    assert r.status_code == 404


# ---- Public share links ------------------------------------------------------


def _create_with_move(client, name="Shared KP"):
    create = client.post(
        "/api/repertoires/create",
        json={"name": name, "color": "white"},
        headers=csrf_headers(client),
    ).json()
    client.post(
        "/api/build/add-move",
        json={
            "repertoire_id": create["repertoire_id"],
            "parent_node_id": create["selected_node_id"],
            "move_uci": "e2e4",
        },
        headers=csrf_headers(client),
    )
    return create


def test_share_link_round_trip_public_read(client):
    """Owner mints a link; ANYONE (no auth) can read the tree through it, minus
    the owner's training colour (health/mastery)."""
    _register(client, "a@example.com", display_name="A")
    create = _create_with_move(client)
    r = client.post(
        "/api/repertoires/share-link",
        json={"repertoire_id": create["repertoire_id"]},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    token = r.json()["token"]
    assert url == f"/?shared={token}"

    anon = _client()  # fresh client: no session at all
    shared = anon.get(f"/api/shared/{token}")
    assert shared.status_code == 200, shared.text
    body = shared.json()
    assert body["shared"] is True
    assert body["name"] == "Shared KP"
    assert "health" not in body
    sans = [n.get("san") for n in body["nodes"] if n.get("san")]
    assert "e4" in sans
    assert all("mastery" not in n for n in body["nodes"])


def test_share_link_is_owner_gated_and_tamper_proof(client):
    _register(client, "a@example.com", display_name="A")
    create = _create_with_move(client)

    other = _client()
    _register(other, "b@example.com", display_name="B")
    # B cannot mint a link for A's repertoire.
    r = other.post(
        "/api/repertoires/share-link",
        json={"repertoire_id": create["repertoire_id"]},
        headers=csrf_headers(other),
    )
    assert r.status_code == 404
    # A doctored token is rejected.
    good = client.post(
        "/api/repertoires/share-link",
        json={"repertoire_id": create["repertoire_id"]},
        headers=csrf_headers(client),
    ).json()["token"]
    rid, sig = good.split(".", 1)
    assert client.get(f"/api/shared/{rid}.{'0' * len(sig)}").status_code == 404
    assert client.get("/api/shared/garbage").status_code == 404


def test_fork_copies_under_caller_with_fresh_ids(client):
    _register(client, "a@example.com", display_name="A")
    create = _create_with_move(client)
    token = client.post(
        "/api/repertoires/share-link",
        json={"repertoire_id": create["repertoire_id"]},
        headers=csrf_headers(client),
    ).json()["token"]

    other = _client()
    _register(other, "b@example.com", display_name="B")
    # Fork requires auth + CSRF.
    assert _client().post(f"/api/shared/{token}/fork").status_code in (401, 403)
    fork = other.post(f"/api/shared/{token}/fork", headers=csrf_headers(other))
    assert fork.status_code == 200, fork.text
    new_id = fork.json()["repertoire_id"]
    assert new_id != create["repertoire_id"]
    # B now owns an independent copy with the same moves.
    mine = other.get("/api/repertoires").json()["repertoires"]
    assert any(rep["id"] == new_id and rep["name"] == "Shared KP" for rep in mine)
    loaded = other.get(f"/api/build/load?repertoire_id={new_id}")
    assert loaded.status_code == 200
    assert "e4" in [n.get("san") for n in loaded.json()["nodes"] if n.get("san")]
    # A's original is untouched and still A's.
    assert client.get(
        f"/api/build/load?repertoire_id={create['repertoire_id']}"
    ).status_code == 200
