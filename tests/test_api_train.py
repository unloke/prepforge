"""Phase 2b-2d-v: ported Train endpoints (spaced-repetition trainer).

``TrainingService`` walks the stored repertoire tree with python-chess only (no
Stockfish/Maia), so the Train surface is a straight port onto the ``current_owner``
bridge. These tests cover gating (auth/CSRF), the start->move->hint->skip round-trip,
input validation, and multi-tenant isolation. The unauthenticated demo
(``/api/train/demo/start``) is intentionally dropped, so there is no test for it.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from api_helpers import csrf_headers


def _register(client: TestClient, email: str) -> str:
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _white_repertoire_with_e4(client: TestClient) -> str:
    """Create a white repertoire whose only own move is 1.e4, so the trainer has
    exactly one prompt (start position, expected e2e4)."""
    created = client.post(
        "/api/repertoires/create",
        json={"name": "King's Pawn", "color": "white"},
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
    return created["repertoire_id"]


def _start(client: TestClient, repertoire_id: str):
    return client.post(
        "/api/train/start",
        json={"repertoire_id": repertoire_id},
        headers=csrf_headers(client),
    )


# ---- gating ----------------------------------------------------------------


def test_start_requires_auth(client):
    assert client.post(
        "/api/train/start", json={"repertoire_id": "x"}, headers=csrf_headers(client)
    ).status_code == 401


def test_start_requires_csrf(client):
    _register(client, "a@example.com")
    assert client.post("/api/train/start", json={"repertoire_id": "x"}).status_code == 403


def test_move_requires_csrf(client):
    _register(client, "a@example.com")
    assert client.post(
        "/api/train/move", json={"session_id": "x", "played_uci": "e2e4"}
    ).status_code == 403


def test_start_foreign_repertoire_is_404(client):
    _register(client, "a@example.com")
    assert _start(client, "does-not-exist").status_code == 404


def test_start_rejects_bad_mode(client):
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    r = client.post(
        "/api/train/start",
        json={"repertoire_id": rep, "mode": "not-a-mode"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


# ---- start -> move -> hint -> skip round-trip ------------------------------


def test_start_returns_first_prompt(client):
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    body = _start(client, rep).json()
    assert body["repertoire_id"] == rep
    assert body["color"] == "white"
    assert body["session_id"]
    assert body["mode"] == "all_lines"
    prompt = body["prompt"]
    # First prompt is the start position; e2e4 is among the offered legal moves.
    assert prompt["current_index"] == 0
    assert "e2e4" in prompt["legal_moves"]


def test_correct_move_grades_and_completes_line(client):
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    session_id = _start(client, rep).json()["session_id"]
    r = client.post(
        "/api/train/move",
        json={"session_id": session_id, "played_uci": "e2e4"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["correct"] is True
    assert body["expected_uci"] == "e2e4"
    assert body["played_san"] == "e4"
    # Only one own move in the line -> the line is complete, no next prompt.
    assert body["completed_line"] is True
    assert body["prompt"] is None
    assert body["progress"]["attempts"] == 1


def test_wrong_move_is_marked_incorrect(client):
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    session_id = _start(client, rep).json()["session_id"]
    body = client.post(
        "/api/train/move",
        json={"session_id": session_id, "played_uci": "d2d4"},
        headers=csrf_headers(client),
    ).json()
    assert body["correct"] is False
    assert body["expected_uci"] == "e2e4"
    # The expected node is now recorded as an open mistake (mistakes are node ids).
    assert body["mistakes"]


def test_hint_reveals_expected_move(client):
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    session_id = _start(client, rep).json()["session_id"]
    body = client.post(
        "/api/train/hint", json={"session_id": session_id}, headers=csrf_headers(client)
    ).json()
    assert body["expected_uci"] == "e2e4"
    assert body["expected_san"] == "e4"
    assert body["piece"] == "Move the pawn"
    assert isinstance(body["strategy"], str) and body["strategy"]


def test_skip_advances_past_the_line(client):
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    session_id = _start(client, rep).json()["session_id"]
    body = client.post(
        "/api/train/skip", json={"session_id": session_id}, headers=csrf_headers(client)
    ).json()
    # Only one line -> skipping it leaves no further prompt.
    assert body["prompt"] is None


# ---- smart queue (Train v2) -------------------------------------------------


def _smart_start(client: TestClient, repertoire_id: str, **extra):
    return client.post(
        "/api/train/smart/start",
        json={"repertoire_id": repertoire_id, **extra},
        headers=csrf_headers(client),
    )


def test_smart_start_requires_auth(client):
    assert _smart_start(client, "x").status_code == 401


def test_smart_start_returns_queue_and_prompt(client):
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    r = _smart_start(client, rep, seed=5)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "smart"
    assert body["total_cards"] == 1
    assert body["counts"]["new"] == 1  # untrained repertoire -> a new card
    prompt = body["prompt"]
    assert prompt["kind"] == "new"
    assert prompt["expected_uci"] == "e2e4"
    assert prompt["run_in"] == []  # first move: nothing to animate in
    assert prompt["hint"]["piece"] == "Move the pawn"
    assert "e2e4" in prompt["legal_moves"]


def test_smart_start_on_empty_repertoire_is_400(client):
    _register(client, "a@example.com")
    created = client.post(
        "/api/repertoires/create",
        json={"name": "Empty", "color": "white"},
        headers=csrf_headers(client),
    ).json()
    assert _smart_start(client, created["repertoire_id"]).status_code == 400


def test_smart_correct_move_completes_card(client):
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    session_id = _smart_start(client, rep, seed=5).json()["session_id"]
    body = client.post(
        "/api/train/smart/move",
        json={"session_id": session_id, "played_uci": "e2e4"},
        headers=csrf_headers(client),
    ).json()
    assert body["correct"] is True
    assert body["sr_written"] is True
    assert body["card_completed"] is True
    assert body["session_completed"] is True
    assert body["prompt"] is None
    assert body["progress"]["attempts"] == 1


def test_smart_retry_attempt_is_not_graded(client):
    """attempt >= 2 never writes spaced-repetition progress; a second wrong
    attempt re-queues the card within the session."""
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    session_id = _smart_start(client, rep, seed=5).json()["session_id"]

    def move(uci, attempt):
        return client.post(
            "/api/train/smart/move",
            json={"session_id": session_id, "played_uci": uci, "attempt": attempt},
            headers=csrf_headers(client),
        ).json()

    first = move("d2d4", 1)
    assert first["correct"] is False and first["sr_written"] is True
    second = move("d2d4", 2)
    assert second["sr_written"] is False
    assert second["progress"] is None
    assert second["requeued"] is True
    assert second["total_cards"] == 2
    # Play-after-reveal advances but stays ungraded.
    third = move("e2e4", 3)
    assert third["correct"] is True and third["sr_written"] is False


def test_smart_skip_advances_past_the_card(client):
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    session_id = _smart_start(client, rep, seed=5).json()["session_id"]
    body = client.post(
        "/api/train/smart/skip",
        json={"session_id": session_id},
        headers=csrf_headers(client),
    ).json()
    assert body["prompt"] is None  # only card skipped -> session over


# ---- multi-tenant isolation ------------------------------------------------


def test_session_is_not_reachable_by_another_owner(client):
    """B must not be able to drive A's training session (IDOR -> 404)."""
    _register(client, "a@example.com")
    rep = _white_repertoire_with_e4(client)
    session_id = _start(client, rep).json()["session_id"]

    from prepforge_chess.api import main

    other = TestClient(main.app)
    _register(other, "b@example.com")
    for path, extra in (
        ("/api/train/move", {"played_uci": "e2e4"}),
        ("/api/train/hint", {}),
        ("/api/train/skip", {}),
        ("/api/train/smart/move", {"played_uci": "e2e4"}),
        ("/api/train/smart/skip", {}),
    ):
        r = other.post(
            path, json={"session_id": session_id, **extra}, headers=csrf_headers(other)
        )
        assert r.status_code == 404, f"{path}: {r.status_code}"


# ---- auth signout shim -----------------------------------------------------


def test_signout_returns_ok_and_clears_session(client):
    _register(client, "a@example.com")
    assert client.get("/api/auth/me").status_code == 200
    r = client.post("/api/auth/signout", json={}, headers=csrf_headers(client))
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    # Cookie cleared -> no longer authenticated.
    assert client.get("/api/auth/me").status_code == 401


def test_signout_requires_csrf(client):
    _register(client, "a@example.com")
    assert client.post("/api/auth/signout", json={}).status_code == 403
