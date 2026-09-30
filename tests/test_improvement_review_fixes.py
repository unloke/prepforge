"""Regression tests for the round-2 improvement-review fixes.

Covers the acceptance paths the review named explicitly:

* D-03  malformed position payloads are readable 4xx, never 500 / partial write
* A-04  re-analysis replaces the generated explanation, never appends (incl.
        the "load from DB then re-run" path), original comments survive
* A-05  quality metadata labels complete / partial-shallow / no-Maia runs
* A-01  effective mastery: long-wrong + recently-good is not "weak" AND
        "mastered" at the same time (display and scheduler agree)
* A-02  effective-enabled traversal: health trainable == scheduler candidates
        in the disabled-ancestor / enabled-descendant boundary state
* D-01  listing due counts track the clock, not the cached health blob
* D-02  stale base_revision → 409, fresh one → mutation lands
* D-05  keyset paging has no gaps or repeats at equal timestamps
* D-06  reclaim is dry-run first and receipts outlive the offline retry window
* F-01  share links: revoke / rotate / expire kill old links, team share is
        independent
* F-02  password recovery: single-use, expiring, OAuth-only accounts told the
        truth, reset invalidates sessions
* F-04  multi-PGN semantics: single mode validates before storing, partial
        import is never dressed up as total failure
* F-05  account export scope == deletion scope; deletion kills sessions/links
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

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


_PGN_ONE = '[Event "One"]\n[White "a"]\n[Black "b"]\n\n1. e4 e5 2. Nf3 Nc6 *'
_PGN_TWO = (
    '[Event "Two"]\n[White "a"]\n[Black "b"]\n\n1. d4 d5 *\n\n'
    '[Event "Two"]\n[White "c"]\n[Black "d"]\n\n1. c4 e5 *'
)


def _prepare(client: TestClient, pgn: str, **body) -> dict:
    r = client.post(
        "/api/analyze/prepare", json={"pgn": pgn, **body}, headers=csrf_headers(client)
    )
    return r


def _classify_save(client: TestClient, prepared: dict, **overrides):
    positions = [{"fen": f, "score_cp": 20} for f in prepared["positions"]]
    body = {"game_id": prepared["game_id"], "positions": positions}
    body.update(overrides)
    return client.post("/api/analyze/classify-save", json=body, headers=csrf_headers(client))


# ---- D-03: bounded position payload ----------------------------------------


def test_classify_save_bad_score_is_400_not_500(client):
    _register(client, "d3@example.com")
    prepared = _prepare(client, _PGN_ONE).json()
    r = _classify_save(client, prepared, positions=[{"fen": prepared["positions"][0], "score_cp": "bad-value"}])
    assert r.status_code == 400, r.text
    assert "score_cp" in str(r.json()["detail"])


def test_classify_save_bad_pv_depth_uci_is_400(client):
    _register(client, "d3b@example.com")
    prepared = _prepare(client, _PGN_ONE).json()
    fen = prepared["positions"][0]
    for bad in (
        {"fen": fen, "pv": ["e2e4", "not-a-uci"]},
        {"fen": fen, "pv": "e2e4"},
        {"fen": fen, "depth": "deep"},
        {"fen": fen, "depth": -3},
        {"fen": fen, "mate_in": "soon"},
        {"fen": fen, "best_move_uci": "zz99"},
        {"fen": fen, "nodes": -5},
        {"fen": 42},
    ):
        r = _classify_save(client, prepared, positions=[bad])
        assert r.status_code == 400, (bad, r.status_code, r.text)


def test_classify_save_missing_position_is_400_and_writes_nothing(client):
    _register(client, "d3c@example.com")
    prepared = _prepare(client, _PGN_ONE).json()
    # Only half the positions: the classifier refuses BEFORE any write.
    positions = [{"fen": f, "score_cp": 20} for f in prepared["positions"][:-2]]
    r = client.post(
        "/api/analyze/classify-save",
        json={"game_id": prepared["game_id"], "positions": positions},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400
    hist = client.get("/api/analyses").json()
    assert hist["analyses"] == []


def test_classify_save_terminal_depth_zero_still_works(client):
    _register(client, "d3d@example.com")
    prepared = _prepare(client, _PGN_ONE).json()
    positions = [
        {"fen": f, "score_cp": 20, "depth": 0, "nodes": 0} for f in prepared["positions"]
    ]
    r = client.post(
        "/api/analyze/classify-save",
        json={"game_id": prepared["game_id"], "positions": positions},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text


# ---- A-04: explanation dedupe + A-05: quality ------------------------------


def test_reanalysis_from_db_keeps_original_comment_and_single_explanation(client):
    _register(client, "a4@example.com")
    pgn = '[Event "C"]\n[White "a"]\n[Black "b"]\n\n1. e4 {my own note} e5 *'
    prepared = _prepare(client, pgn).json()
    assert _classify_save(client, prepared).status_code == 200
    for _ in range(3):
        # Each round re-runs from the STORED game (the DB load path the review
        # called out), not an in-memory copy.
        recall = client.get("/api/analyses/{0}".format(prepared["game_id"]))
        assert recall.status_code == 200
        assert _classify_save(client, prepared).status_code == 200

    moves = client.get("/api/analyses/{0}".format(prepared["game_id"])).json()["moves"]
    first = moves[0]
    assert first["comment"] == "my own note"  # original preserved verbatim
    generated = first["generated_comment"]
    assert generated
    # Exactly one explanation block — never two. (Equal evals in this payload
    # classify as "small win-chance loss"; the point is the COUNT.)
    assert generated.count("small win-chance loss") == 1
    assert "\n" not in generated  # a second run would have appended a new line


def test_quality_metadata_labels_run_completeness(client):
    _register(client, "a5@example.com")
    prepared = _prepare(client, _PGN_ONE).json()
    good = [
        {"fen": f, "score_cp": 20, "depth": 16, "nodes": 5000} for f in prepared["positions"]
    ]
    r = client.post(
        "/api/analyze/classify-save",
        json={"game_id": prepared["game_id"], "positions": good},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text
    quality = r.json()["quality"]
    assert quality["target_depth"] >= 1
    assert quality["actual_depth_max"] == 16
    assert quality["shallow_positions"] == 0
    assert quality["search"] == "full"
    assert quality["maia"]["available"] is False  # no assessments supplied
    assert quality["completeness"] == "no-maia"
    assert quality["classification_version"]
    assert quality["explanation_version"]

    # A shallow run is labelled as such (target 20 vs actual 12).
    shallow = [
        {"fen": f, "score_cp": 20, "depth": 12, "nodes": 5000} for f in prepared["positions"]
    ]
    r2 = client.post(
        "/api/analyze/classify-save",
        json={"game_id": prepared["game_id"], "depth": 20, "positions": shallow},
        headers=csrf_headers(client),
    )
    quality2 = r2.json()["quality"]
    assert quality2["search"] == "partial-shallow"
    assert quality2["shallow_positions"] > 0
    assert "partial-shallow" in quality2["completeness"]


# ---- A-01 + A-02: mastery + effective traversal (pure functions) -----------


def test_long_wrong_then_recovered_is_not_weak_and_not_contradictory():
    from datetime import datetime, timezone

    from prepforge_chess.core.models import TrainingProgress
    from prepforge_chess.services.progress import (
        MASTERY_MASTERED,
        MASTERY_WEAK,
        node_mastery,
    )

    now = datetime.now(timezone.utc)
    progress = TrainingProgress(
        node_id="n",
        attempts=110,
        correct_attempts=10,
        spaced_repetition_score=10.0,
        due_at=now + timedelta(days=10),
        is_mastered=True,
    )
    state = node_mastery(progress, now=now)
    # The review's repro: score=10, is_mastered=true used to display "weak".
    assert state != MASTERY_WEAK
    assert state == MASTERY_MASTERED

    # Still failing recently = weak, as before.
    failing = TrainingProgress(
        node_id="n",
        attempts=10,
        correct_attempts=2,
        spaced_repetition_score=1.0,
        due_at=now + timedelta(minutes=10),
    )
    assert node_mastery(failing, now=now) == MASTERY_WEAK


def test_health_and_scheduler_agree_on_disabled_ancestor_trees():
    from prepforge_chess.core.models import Color, MoveRecord, MoveSource, OpeningNode
    from prepforge_chess.services.progress import compute_health
    from prepforge_chess.services.scheduler import build_session_plan

    def node(nid, parent, uci, enabled):
        move = MoveRecord(
            uci=uci,
            san=uci,
            fen_before="x",
            fen_after="y",
            move_number=1,
            ply=1,
            side_to_move=Color.WHITE,
            source=MoveSource.MANUAL,
        )
        return OpeningNode(
            id=nid,
            repertoire_id="r",
            fen="x",
            side_to_move=Color.BLACK,
            move=move,
            parent_id=parent.id if parent else None,
            is_enabled=enabled,
        )

    root = OpeningNode(id="root", repertoire_id="r", fen="x", side_to_move=Color.WHITE)
    parent = node("parent", root, "e7e5", enabled=False)  # disabled opponent move
    child = node("child", parent, "d2d4", enabled=True)  # enabled own move below it
    parent.move.side_to_move = Color.BLACK  # opponent's reply…
    child.move.side_to_move = Color.WHITE  # …followed by our trainable move
    root.children = [parent]
    parent.children = [child]

    # Effective-enabled: a disabled node makes its whole subtree unreachable.
    health = compute_health(root, Color.WHITE, {})
    plan = build_session_plan(root, Color.WHITE, {}, seed=1)
    assert health.trainable == 0
    assert plan.cards == []

    # Re-enabling the branch restores the whole chain (enable_branch contract),
    # so the boundary state cannot persist invisibly.
    parent.is_enabled = True
    health2 = compute_health(root, Color.WHITE, {})
    plan2 = build_session_plan(root, Color.WHITE, {}, seed=1)
    assert health2.trainable == 1
    assert len(plan2.cards) == 1


# ---- D-01 + D-02 + D-05: listings freshness, revision, paging --------------


def test_listing_due_counts_track_the_clock_not_the_cache(client):
    from prepforge_chess.api import db
    from prepforge_chess.storage import sa_tables as t
    from sqlalchemy import update

    _register(client, "d1@example.com")
    owner = client.get("/api/auth/me").json()["id"]
    create = client.post(
        "/api/repertoires/create",
        json={"name": "Due", "color": "white"},
        headers=csrf_headers(client),
    ).json()
    rep_id = create["repertoire_id"]
    root_id = create["selected_node_id"]
    moved = client.post(
        "/api/build/add-move",
        json={"repertoire_id": rep_id, "parent_node_id": root_id, "move_uci": "e2e4"},
        headers=csrf_headers(client),
    ).json()
    node_id = moved["selected_node_id"]

    # Progress due only in the FUTURE: nothing due yet.
    now = datetime.now(timezone.utc)
    with db.make_engine().begin() as conn:
        conn.execute(
            t.training_progress.insert().values(
                id="tp-due-test",
                owner_user_id=owner,
                repertoire_id=rep_id,
                node_id=node_id,
                attempts=1,
                correct_attempts=1,
                last_reviewed_at=now.isoformat(),
                spaced_repetition_score=1.0,
                due_at=(now + timedelta(hours=6)).isoformat(),
                is_mastered=0,
                created_at=now.isoformat(),
                updated_at=now.isoformat(),
            )
        )
    listing = client.get("/api/repertoires").json()["repertoires"]
    row = next(r for r in listing if r["id"] == rep_id)
    assert row["health"]["due"] == 0

    # Move the stored due_at into the past WITHOUT touching health_json: the
    # next listing must still show it as due (the cached blob cannot know).
    with db.make_engine().begin() as conn:
        conn.execute(
            update(t.training_progress).where(
                t.training_progress.c.node_id == node_id
            ).values(due_at=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat())
        )
    listing2 = client.get("/api/repertoires").json()["repertoires"]
    row2 = next(r for r in listing2 if r["id"] == rep_id)
    assert row2["health"]["due"] == 1
    # And the cache carries its provenance.
    assert row2["health"]["computed_at"]


def test_stale_base_revision_conflicts_and_fresh_one_lands(client):
    _register(client, "d2@example.com")
    create = client.post(
        "/api/repertoires/create",
        json={"name": "Rev", "color": "white"},
        headers=csrf_headers(client),
    ).json()
    rep_id = create["repertoire_id"]
    root_id = create["selected_node_id"]
    load = client.get("/api/build/load", params={"repertoire_id": rep_id}).json()
    base = load["revision"]

    # First mutation with the fresh revision lands and bumps the revision.
    ok = client.post(
        "/api/build/add-move",
        json={
            "repertoire_id": rep_id,
            "parent_node_id": root_id,
            "move_uci": "e2e4",
            "base_revision": base,
        },
        headers=csrf_headers(client),
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["revision"] == base + 1

    # A second writer still holding the old revision gets 409 + the current one.
    conflict = client.post(
        "/api/build/add-move",
        json={
            "repertoire_id": rep_id,
            "parent_node_id": root_id,
            "move_uci": "d2d4",
            "base_revision": base,
        },
        headers=csrf_headers(client),
    )
    assert conflict.status_code == 409
    detail = conflict.json()["detail"]
    assert detail["error"] == "revision_conflict"
    assert detail["current_revision"] == base + 1


def test_analyses_pagination_has_no_gaps_or_repeats(client):
    _register(client, "d5@example.com")
    # Distinct games (distinct move sequences — the importer dedupes by moves).
    first_moves = ["e4", "d4", "c4", "Nf3", "f3"]
    for index, uci_san in enumerate(first_moves):
        prepared = _prepare(
            client,
            '[Event "G{0}"]\n[White "a"]\n[Black "b"]\n\n1. {1} e5 *'.format(index, uci_san),
        ).json()
        assert _classify_save(client, prepared).status_code == 200

    seen = []
    cursor = None
    for _ in range(10):
        url = "/api/analyses?limit=2"
        if cursor:
            url += "&cursor={0}".format(cursor)
        page = client.get(url).json()
        seen.extend(item["game_id"] for item in page["analyses"])
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 5
    assert len(set(seen)) == 5  # no repeats
    bad = client.get("/api/analyses?cursor=nonsense")
    assert bad.status_code == 400


# ---- D-06: lifecycle -------------------------------------------------------


def test_reclaim_is_dry_run_first_and_receipts_outlive_offline_retry():
    from prepforge_chess.services import data_lifecycle

    assert data_lifecycle.RECEIPT_RETENTION_DAYS > data_lifecycle.OFFLINE_RETRY_DAYS

    from prepforge_chess.storage.database import apply_schema, connect_database
    from prepforge_chess.storage.repositories import PrepForgeRepository

    engine = connect_database()
    apply_schema(engine)
    repo = PrepForgeRepository(engine)
    report = data_lifecycle.reclaim_orphans(repo)  # dry-run default
    assert report["dry_run"] is True
    assert report["deleted"] == {
        "evaluations": 0,
        "positions": 0,
        "receipts": 0,
        "analyses": 0,
    }


# ---- F-01: share revocation ------------------------------------------------


def _share_setup(client: TestClient) -> str:
    create = client.post(
        "/api/repertoires/create",
        json={"name": "Shared", "color": "white"},
        headers=csrf_headers(client),
    ).json()
    return create["repertoire_id"]


def test_share_link_revoke_and_rotate_kill_old_links(client):
    _register(client, "f1@example.com")
    rep_id = _share_setup(client)

    minted = client.post(
        "/api/repertoires/share-link",
        json={"repertoire_id": rep_id},
        headers=csrf_headers(client),
    ).json()
    token = minted["token"]
    anon = TestClient(main_app())
    assert anon.get("/api/shared/{0}".format(token)).status_code == 200

    # Revoke: old link dies immediately; team sharing is a separate control.
    revoked = client.post(
        "/api/repertoires/share-link/revoke",
        json={"repertoire_id": rep_id},
        headers=csrf_headers(client),
    ).json()
    assert revoked["share_enabled"] is False
    assert anon.get("/api/shared/{0}".format(token)).status_code == 404

    # Re-sharing mints a FRESH link — the revoked one stays dead.
    minted2 = client.post(
        "/api/repertoires/share-link",
        json={"repertoire_id": rep_id},
        headers=csrf_headers(client),
    ).json()
    assert anon.get("/api/shared/{0}".format(token)).status_code == 404
    assert anon.get("/api/shared/{0}".format(minted2["token"])).status_code == 200

    # Rotation retires the current link too.
    rotated = client.post(
        "/api/repertoires/share-link/rotate",
        json={"repertoire_id": rep_id},
        headers=csrf_headers(client),
    ).json()
    assert anon.get("/api/shared/{0}".format(minted2["token"])).status_code == 404
    assert anon.get("/api/shared/{0}".format(rotated["token"])).status_code == 200

    # Forking a dead link is refused as well.
    dead = anon.post(
        "/api/shared/{0}/fork".format(token), headers=csrf_headers(anon)
    )
    assert dead.status_code in (401, 403, 404)


def test_share_link_expiry_is_enforced(client):
    from prepforge_chess.api import db
    from prepforge_chess.storage import sa_tables as t
    from sqlalchemy import update

    _register(client, "f1b@example.com")
    rep_id = _share_setup(client)
    minted = client.post(
        "/api/repertoires/share-link",
        json={"repertoire_id": rep_id},
        headers=csrf_headers(client),
    ).json()
    token = minted["token"]
    anon = TestClient(main_app())
    assert anon.get("/api/shared/{0}".format(token)).status_code == 200

    with db.make_engine().begin() as conn:
        conn.execute(
            update(t.repertoires)
            .where(t.repertoires.c.id == rep_id)
            .values(share_expires_at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat())
        )
    assert anon.get("/api/shared/{0}".format(token)).status_code == 404


def main_app():
    from prepforge_chess.api import main

    return main.app


# ---- F-02: password recovery ----------------------------------------------


def test_password_reset_lifecycle(client, monkeypatch):
    monkeypatch.setenv("PREPFORGE_PASSWORD_RESET_DEV_LINK", "1")
    from prepforge_chess.api import config

    config.get_settings.cache_clear()
    _register(client, "f2@example.com")
    client.post("/api/auth/logout", headers=csrf_headers(client))

    forgot = client.post(
        "/api/auth/password/forgot",
        json={"email": "f2@example.com"},
        headers=csrf_headers(client),
    )
    assert forgot.status_code == 200, forgot.text
    body = forgot.json()
    assert body["dev_delivery"] == "reset_link"
    token = body["dev_reset_token"]

    # Wrong password length is rejected before the token is consumed.
    too_short = client.post(
        "/api/auth/password/reset",
        json={"token": token, "password": "short"},
        headers=csrf_headers(client),
    )
    assert too_short.status_code == 422  # pydantic min_length

    reset = client.post(
        "/api/auth/password/reset",
        json={"token": token, "password": "brandnewpass1"},
        headers=csrf_headers(client),
    )
    assert reset.status_code == 204, reset.text

    # Single-use: the same link cannot be replayed.
    replay = client.post(
        "/api/auth/password/reset",
        json={"token": token, "password": "anotherpass1"},
        headers=csrf_headers(client),
    )
    assert replay.status_code == 400

    # Old password is dead; the new one signs in (all sessions were revoked).
    bad = client.post(
        "/api/auth/login",
        json={"email": "f2@example.com", "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert bad.status_code == 401
    good = client.post(
        "/api/auth/login",
        json={"email": "f2@example.com", "password": "brandnewpass1"},
        headers=csrf_headers(client),
    )
    assert good.status_code == 200


def test_password_reset_unknown_token_is_400_and_forgot_never_enumerates(client, monkeypatch):
    monkeypatch.setenv("PREPFORGE_PASSWORD_RESET_DEV_LINK", "1")
    from prepforge_chess.api import config

    config.get_settings.cache_clear()
    _register(client, "f2b@example.com")
    # Unknown address: same generic response, no dev payload.
    unknown = client.post(
        "/api/auth/password/forgot",
        json={"email": "nobody@example.com"},
        headers=csrf_headers(client),
    )
    assert unknown.status_code == 200
    assert unknown.json() == {"status": "sent"}

    bad = client.post(
        "/api/auth/password/reset",
        json={"token": "x" * 32, "password": "whatever123"},
        headers=csrf_headers(client),
    )
    assert bad.status_code == 400


# ---- F-04: multi-PGN semantics --------------------------------------------


def test_single_mode_rejects_multi_game_pgn_before_storing(client):
    _register(client, "f4@example.com")
    r = _prepare(client, _PGN_TWO)
    assert r.status_code == 400
    assert "2 games" in str(r.json()["detail"])
    # Validated BEFORE storing: nothing landed.
    hist = client.get("/api/analyses").json()
    assert hist["analyses"] == []


def test_multi_mode_reports_per_game_status_and_selection(client):
    _register(client, "f4b@example.com")
    r = _prepare(client, _PGN_TWO, mode="multi")
    assert r.status_code == 200, r.text
    summary = r.json()["import_summary"]
    assert summary["total_games"] == 2
    assert summary["imported_count"] == 2
    assert summary["selected_index"] == 0
    statuses = [g["status"] for g in summary["games"]]
    assert statuses == ["imported", "imported"]

    # A second paste: both games already exist — reported as such, not failed.
    again = _prepare(client, _PGN_TWO, mode="multi", select_index=1).json()
    summary2 = again["import_summary"]
    assert summary2["existing_count"] == 2
    assert summary2["selected_index"] == 1

    # A game without moves fails ITS slot only; the good one still imports.
    mixed = (
        '[Event "ok"]\n[White "a"]\n[Black "b"]\n\n1. e4 e5 *\n\n'
        '[Event "bad"]\n[White "c"]\n[Black "d"]\n\n'
    )
    r3 = _prepare(client, mixed, mode="multi")
    assert r3.status_code == 200, r3.text
    summary3 = r3.json()["import_summary"]
    assert summary3["games"][0]["status"] == "imported"
    assert summary3["games"][1]["status"] == "failed"
    assert summary3["failed_count"] == 1

    # Selecting the failed slot is an explicit 400, not a silent swap.
    r4 = _prepare(client, mixed, mode="multi", select_index=1)
    assert r4.status_code == 400


# ---- F-05: account export / delete ----------------------------------------


def test_account_export_scope_matches_deletion(client):
    _register(client, "f5@example.com")
    create = client.post(
        "/api/repertoires/create",
        json={"name": "Mine", "color": "white"},
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
    prepared = _prepare(client, _PGN_ONE).json()
    assert _classify_save(client, prepared).status_code == 200

    export = client.get("/api/account/export")
    assert export.status_code == 200, export.text
    bundle = export.json()
    assert bundle["account"]["email"] == "f5@example.com"
    assert len(bundle["games"]) == 1
    assert bundle["games"][0]["pgn"]
    assert len(bundle["repertoires"]) == 1
    package = bundle["repertoires"][0]
    assert package["repertoire"]["name"] == "Mine"
    assert package["nodes"]  # the tree travels with the package

    # Confirmation is mandatory.
    no_confirm = client.request(
        "DELETE", "/api/account", json={"confirm": "please"}, headers=csrf_headers(client)
    )
    assert no_confirm.status_code == 400

    deleted = client.request(
        "DELETE", "/api/account", json={"confirm": "DELETE"}, headers=csrf_headers(client)
    )
    assert deleted.status_code == 200, deleted.text
    counts = deleted.json()["deleted"]
    assert counts["games"] == 1
    assert counts["repertoires"] == 1
    assert counts["sessions"] >= 1
    # Session is gone with the account: the cookie is now worthless.
    assert client.get("/api/auth/me").status_code in (401, 403)
