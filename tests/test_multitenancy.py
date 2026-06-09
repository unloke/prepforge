"""Per-user data isolation foundation (multi-tenancy track).

Covers the new session/identity layer and owner-scoped reads/writes: repository
round-trips, app-level scoping of repertoires/games/analyses, the HTTP cookie
session (a fresh browser gets its own empty view), and guest→Lichess migration.
"""
import http.cookiejar
import json
import threading
import urllib.error
import urllib.request
from contextlib import contextmanager
from http.server import ThreadingHTTPServer

import pytest

from prepforge_chess.storage.database import initialize_database
from prepforge_chess.storage.repositories import PrepForgeRepository
from prepforge_chess.web.server import (
    PrepForgeWebApp,
    SESSION_COOKIE_NAME,
    _handler_for_app,
)


# ---- Repository: sessions / profiles --------------------------------------


def _repo():
    return PrepForgeRepository(initialize_database(":memory:"))


def test_guest_session_round_trip_and_uniqueness():
    repo = _repo()
    pid = repo.create_guest_session("hash-a")
    assert repo.session_user("hash-a") == pid
    assert repo.session_user("unknown") is None
    # A second browser gets a distinct profile.
    pid2 = repo.create_guest_session("hash-b")
    assert pid2 != pid


def test_rebind_session_points_at_new_profile():
    repo = _repo()
    guest = repo.create_guest_session("hash")
    account = repo.create_user_profile(display_name="acct")
    repo.rebind_session("hash", account)
    assert repo.session_user("hash") == account
    assert account != guest


def test_ensure_lichess_profile_is_idempotent_case_insensitive():
    repo = _repo()
    first = repo.ensure_lichess_profile("Magnus")
    assert repo.ensure_lichess_profile("magnus") == first  # COLLATE NOCASE
    other = repo.ensure_lichess_profile("Hikaru")
    assert other != first


def test_reassign_owner_moves_repertoires_between_profiles(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    guest = app.repository.create_guest_session("hash")
    app.create_repertoire_payload("Guest rep", "white", owner_user_id=guest)
    account = app.repository.ensure_lichess_profile("player")

    assert len(app.list_repertoires_payload(owner_user_id=guest)["repertoires"]) == 1
    app.repository.reassign_owner(guest, account)
    assert len(app.list_repertoires_payload(owner_user_id=guest)["repertoires"]) == 0
    assert len(app.list_repertoires_payload(owner_user_id=account)["repertoires"]) == 1


# ---- App-level scoping -----------------------------------------------------


def test_repertoires_are_isolated_by_owner(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    a = app.repository.create_user_profile(display_name="A")
    b = app.repository.create_user_profile(display_name="B")

    app.create_repertoire_payload("A's rep", "white", owner_user_id=a)

    assert len(app.list_repertoires_payload(owner_user_id=a)["repertoires"]) == 1
    assert len(app.list_repertoires_payload(owner_user_id=b)["repertoires"]) == 0
    # No owner = unscoped admin view still sees everything.
    assert len(app.list_repertoires_payload()["repertoires"]) == 1


def test_repertoire_load_is_owner_gated(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    a = app.repository.create_user_profile(display_name="A")
    b = app.repository.create_user_profile(display_name="B")
    created = app.create_repertoire_payload("A's rep", "white", owner_user_id=a)
    rep_id = created["repertoire_id"]

    assert app.load_repertoire_payload(rep_id, owner_user_id=a)["repertoire_id"] == rep_id
    with pytest.raises(ValueError):
        app.load_repertoire_payload(rep_id, owner_user_id=b)


def test_games_and_dashboard_are_isolated_by_owner(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    a = app.repository.create_user_profile(display_name="A")
    b = app.repository.create_user_profile(display_name="B")

    app.prepare_analysis_payload("1. e4 e5 2. Nf3 Nc6 *", owner_user_id=a)

    assert app.dashboard_payload(owner_user_id=a)["games"] == 1
    assert app.dashboard_payload(owner_user_id=b)["games"] == 0


def test_dashboard_training_counters_are_owner_scoped(tmp_path):
    from datetime import datetime, timedelta, timezone

    from prepforge_chess.core.models import (
        TrainingMode,
        TrainingProgress,
        TrainingSession,
    )

    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    a = app.repository.create_user_profile(display_name="A")
    b = app.repository.create_user_profile(display_name="B")
    rep_a = app.create_repertoire_payload("A rep", "white", owner_user_id=a)
    rep_b = app.create_repertoire_payload("B rep", "white", owner_user_id=b)

    app.repository.save_training_session(
        TrainingSession(id="s-a", repertoire_id=rep_a["repertoire_id"], mode=TrainingMode.ALL_LINES, line_order=[])
    )
    app.repository.save_training_session(
        TrainingSession(id="s-b", repertoire_id=rep_b["repertoire_id"], mode=TrainingMode.ALL_LINES, line_order=[])
    )

    past = datetime.now(timezone.utc) - timedelta(days=1)
    # One open mistake (attempts > correct) that is also due, per owner.
    app.repository.save_training_progress(
        rep_a["repertoire_id"],
        TrainingProgress(node_id=rep_a["selected_node_id"], attempts=3, correct_attempts=1, due_at=past),
        user_profile_id=a,
    )
    app.repository.save_training_progress(
        rep_b["repertoire_id"],
        TrainingProgress(node_id=rep_b["selected_node_id"], attempts=2, correct_attempts=0, due_at=past),
        user_profile_id=b,
    )

    da = app.dashboard_payload(owner_user_id=a)
    db = app.dashboard_payload(owner_user_id=b)
    assert (da["training_sessions"], da["open_mistakes"], da["due_reviews"]) == (1, 1, 1)
    assert (db["training_sessions"], db["open_mistakes"], db["due_reviews"]) == (1, 1, 1)
    # The unscoped admin view still sees the global totals.
    glob = app.dashboard_payload()
    assert (glob["training_sessions"], glob["open_mistakes"], glob["due_reviews"]) == (2, 2, 2)


def test_classify_save_rejects_another_owners_game(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    a = app.repository.create_user_profile(display_name="A")
    b = app.repository.create_user_profile(display_name="B")
    prep = app.prepare_analysis_payload("1. e4 e5 *", owner_user_id=a)
    game_id = prep["game_id"]

    # B cannot persist analysis into A's game (treated as not-found).
    with pytest.raises(ValueError):
        app.classify_save_payload(
            game_id=game_id,
            positions=[{"fen": prep["positions"][0]}],
            owner_user_id=b,
        )


# ---- App-level scoping: write/mutation IDOR gates --------------------------


def _two_owner_app_with_rep(tmp_path):
    """An app with profiles A and B, plus a repertoire owned by A that already
    has one move under the root (so node-scoped mutations have a target)."""
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    a = app.repository.create_user_profile(display_name="A")
    b = app.repository.create_user_profile(display_name="B")
    created = app.create_repertoire_payload("A's rep", "white", owner_user_id=a)
    rep_id = created["repertoire_id"]
    moved = app.build_add_move_payload(
        repertoire_id=rep_id,
        parent_node_id=created["selected_node_id"],
        move_uci="e2e4",
        owner_user_id=a,
    )
    node_id = moved["selected_node_id"]
    return app, a, b, rep_id, node_id


def test_rename_delete_set_active_reject_another_owner(tmp_path):
    app, a, b, rep_id, _node = _two_owner_app_with_rep(tmp_path)
    for call in (
        lambda owner: app.rename_repertoire_payload(rep_id, "hijacked", owner_user_id=owner),
        lambda owner: app.set_repertoire_active_payload(rep_id, False, owner_user_id=owner),
        lambda owner: app.delete_repertoire_payload(rep_id, owner_user_id=owner),
    ):
        with pytest.raises(ValueError):
            call(b)
    # A (the real owner) can still mutate, and the repertoire survived B's attempts.
    assert app.rename_repertoire_payload(rep_id, "kept", owner_user_id=a)["name"] == "kept"


def test_node_mutations_reject_another_owner(tmp_path):
    app, a, b, rep_id, node_id = _two_owner_app_with_rep(tmp_path)
    with pytest.raises(ValueError):
        app.build_add_move_payload(
            repertoire_id=rep_id,
            parent_node_id=node_id,
            move_uci="e7e5",
            owner_user_id=b,
        )
    with pytest.raises(ValueError):
        app.build_node_action_payload(
            repertoire_id=rep_id, node_id=node_id, action="mark_critical", owner_user_id=b
        )
    with pytest.raises(ValueError):
        app.build_set_annotations_payload(
            repertoire_id=rep_id, node_id=node_id, arrows=[], circles=[], owner_user_id=b
        )
    with pytest.raises(ValueError):
        app.build_export_payload(
            repertoire_id=rep_id, export_format="pgn", owner_user_id=b
        )
    # A can still act on its own node.
    assert app.build_node_action_payload(
        repertoire_id=rep_id, node_id=node_id, action="mark_critical", owner_user_id=a
    )["repertoire_id"] == rep_id


def test_apply_plan_rejects_another_owner(tmp_path):
    # apply-plan runs no compute (browser-built plan), so it is not engine-gated —
    # but it must still reject a plan aimed at another owner's repertoire.
    app, a, b, rep_id, node_id = _two_owner_app_with_rep(tmp_path)
    with pytest.raises(ValueError):
        app.build_apply_plan_payload(
            repertoire_id=rep_id, root_node_id=node_id, plan={}, owner_user_id=b
        )


def test_build_generate_is_engine_gated_before_owner_gate(tmp_path):
    # On the no-compute deploy the engine gate fires first, so every caller (even a
    # cross-owner one) gets a uniform ServerEngineDisabled — no IDOR surface here.
    from prepforge_chess.web.server import ServerEngineDisabled

    app, a, b, rep_id, node_id = _two_owner_app_with_rep(tmp_path)
    assert app.server_engine_enabled is False
    with pytest.raises(ServerEngineDisabled):
        app.build_generate_payload(repertoire_id=rep_id, node_id=node_id, owner_user_id=b)
    with pytest.raises(ServerEngineDisabled):
        app.start_build_generate_payload(
            repertoire_id=rep_id, node_id=node_id, owner_user_id=b
        )


def test_training_start_rejects_another_owner(tmp_path):
    app, a, b, rep_id, _node = _two_owner_app_with_rep(tmp_path)
    with pytest.raises(ValueError):
        app.start_training_payload(repertoire_id=rep_id, owner_user_id=b)


def test_training_session_endpoints_reject_another_owner(tmp_path):
    from prepforge_chess.core.models import TrainingMode, TrainingSession

    app, a, b, rep_id, _node = _two_owner_app_with_rep(tmp_path)
    session = TrainingSession(
        id="sess-a",
        repertoire_id=rep_id,
        mode=TrainingMode.ALL_LINES,
        line_order=[],
    )
    app.repository.save_training_session(session)

    with pytest.raises(ValueError):
        app.submit_training_move_payload("sess-a", "e2e4", owner_user_id=b)
    with pytest.raises(ValueError):
        app.skip_training_line_payload("sess-a", owner_user_id=b)
    with pytest.raises(ValueError):
        app.train_hint_payload("sess-a", owner_user_id=b)


def test_demo_training_session_is_shared_not_owner_gated(tmp_path):
    """The trainer demo lives on an ownerless repertoire; a scoped owner must still
    be able to drive its session (the gate only blocks *another* owner's data)."""
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    owner = app.repository.create_user_profile(display_name="guest")
    demo = app.start_training_demo_payload()
    session_id = demo["session_id"]
    # Hint on the shared demo session does not raise for a scoped owner.
    assert "expected_uci" in app.train_hint_payload(session_id, owner_user_id=owner)


# ---- Per-owner game dedup --------------------------------------------------


def test_two_owners_import_same_pgn_independently(tmp_path):
    # Regression: before per-owner dedup, B importing a PGN A already had was bounced
    # to A's game and then rejected by the ownership gate (a real functional bug).
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    a = app.repository.create_user_profile(display_name="A")
    b = app.repository.create_user_profile(display_name="B")
    pgn = "1. e4 e5 2. Nf3 Nc6 *"

    pa = app.prepare_analysis_payload(pgn, owner_user_id=a)
    pb = app.prepare_analysis_payload(pgn, owner_user_id=b)

    assert pa["game_id"] != pb["game_id"]  # each owner gets an independent copy
    assert app.dashboard_payload(owner_user_id=a)["games"] == 1
    assert app.dashboard_payload(owner_user_id=b)["games"] == 1

    # Same owner re-importing still dedups to their own existing game.
    pa2 = app.prepare_analysis_payload(pgn, owner_user_id=a)
    assert pa2["game_id"] == pa["game_id"]
    assert app.dashboard_payload(owner_user_id=a)["games"] == 1


def test_two_owners_import_same_lichess_game_independently(tmp_path):
    # The same lichess_id must be storable once per owner (the global UNIQUE that the
    # migration drops would otherwise make the second insert fail).
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    a = app.repository.create_user_profile(display_name="A")
    b = app.repository.create_user_profile(display_name="B")
    pgn = '[Site "https://lichess.org/abcd1234"]\n\n1. e4 e5 2. Nf3 *'

    ga = app.prepare_analysis_payload(pgn, owner_user_id=a)["game_id"]
    gb = app.prepare_analysis_payload(pgn, owner_user_id=b)["game_id"]

    assert ga != gb
    assert app.repository.find_game_id_by_lichess_id("abcd1234", owner_user_id=a) == ga
    assert app.repository.find_game_id_by_lichess_id("abcd1234", owner_user_id=b) == gb


# ---- Per-user Lichess token / status ---------------------------------------


def test_lichess_connection_is_per_user(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    a = app.repository.ensure_lichess_profile("alice")
    b = app.repository.create_user_profile(display_name="B")
    app.repository.set_profile_setting(a, "lichess.oauth", {"access_token": "tok-a"})

    assert app.lichess_status_payload(owner_user_id=a) == {"connected": True, "username": "alice"}
    assert app.lichess_status_payload(owner_user_id=b) == {"connected": False, "username": None}

    # B disconnecting must not touch A's token.
    app.lichess_disconnect_payload(owner_user_id=b)
    assert app.lichess_status_payload(owner_user_id=a)["connected"] is True
    # A disconnecting clears only A.
    app.lichess_disconnect_payload(owner_user_id=a)
    assert app.lichess_status_payload(owner_user_id=a)["connected"] is False


def test_oauth_callback_stores_token_on_profile_not_global(tmp_path, monkeypatch):
    from prepforge_chess.web import server as server_mod

    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    guest = app.repository.create_guest_session("hash")
    app.__dict__.setdefault("_oauth_pending", {})["st"] = {
        "verifier": "v",
        "redirect_uri": "r",
    }
    monkeypatch.setattr(server_mod, "exchange_code", lambda **kw: {"access_token": "tok"})
    monkeypatch.setattr(server_mod, "fetch_username", lambda token: "Bob")

    username = app.lichess_handle_callback(
        code="c", state="st", owner_user_id=guest, session_token_hash="hash"
    )
    assert username == "Bob"

    account = app.repository.find_profile_by_lichess("Bob")
    assert app.repository.get_profile_setting(account, "lichess.oauth") == {"access_token": "tok"}
    # The token must NOT leak into the legacy global slot.
    assert app.settings.get("lichess.oauth") is None
    # The rebound session (now the account profile) reads as connected.
    assert app.lichess_status_payload(owner_user_id=account)["connected"] is True
    assert app.repository.session_user("hash") == account


def _seed_oauth_pending(app, state):
    app.__dict__.setdefault("_oauth_pending", {})[state] = {
        "verifier": "v",
        "redirect_uri": "r",
    }


def test_oauth_migrates_guest_data_but_never_between_accounts(tmp_path, monkeypatch):
    # The dangerous bug this guards: switching accounts on the same browser must NOT
    # drag account A's data into account B. Guest → account adoption still works.
    from prepforge_chess.web import server as server_mod

    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    monkeypatch.setattr(server_mod, "exchange_code", lambda **kw: {"access_token": "t"})

    # A brand-new browser (guest) builds a repertoire, then logs in as account A.
    guest = app.repository.create_guest_session("hash")
    app.create_repertoire_payload("guest d4", "white", owner_user_id=guest)
    _seed_oauth_pending(app, "s1")
    monkeypatch.setattr(server_mod, "fetch_username", lambda token: "accountA")
    app.lichess_handle_callback(
        code="c", state="s1", owner_user_id=guest, session_token_hash="hash"
    )
    account_a = app.repository.find_profile_by_lichess("accountA")
    # guest → account: the guest's repertoire was adopted by A.
    assert len(app.list_repertoires_payload(owner_user_id=account_a)["repertoires"]) == 1
    assert app.repository.session_user("hash") == account_a

    # Same browser now logs in as account B (current session owner is A, an account).
    current_owner = app.repository.session_user("hash")
    _seed_oauth_pending(app, "s2")
    monkeypatch.setattr(server_mod, "fetch_username", lambda token: "accountB")
    app.lichess_handle_callback(
        code="c", state="s2", owner_user_id=current_owner, session_token_hash="hash"
    )
    account_b = app.repository.find_profile_by_lichess("accountB")

    # A's repertoire stays with A; B starts empty; the session now points at B.
    assert len(app.list_repertoires_payload(owner_user_id=account_a)["repertoires"]) == 1
    assert len(app.list_repertoires_payload(owner_user_id=account_b)["repertoires"]) == 0
    assert app.repository.session_user("hash") == account_b


def test_auth_status_reflects_account_not_lichess_token(tmp_path):
    # The Sign-out affordance keys off this: a guest is not signed in; an account is,
    # and STAYS signed in after disconnecting the Lichess token (still bound to it).
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    guest = app.repository.create_guest_session("h")
    a = app.repository.ensure_lichess_profile("alice")
    app.repository.set_profile_setting(a, "lichess.oauth", {"access_token": "t"})

    assert app.auth_status_payload(owner_user_id=guest) == {"signed_in": False, "username": None}
    assert app.auth_status_payload(owner_user_id=None) == {"signed_in": False, "username": None}
    assert app.auth_status_payload(owner_user_id=a) == {"signed_in": True, "username": "alice"}

    app.lichess_disconnect_payload(owner_user_id=a)
    assert app.lichess_status_payload(owner_user_id=a)["connected"] is False
    # Token gone, but still signed in as the account (so Sign out stays available).
    assert app.auth_status_payload(owner_user_id=a) == {"signed_in": True, "username": "alice"}


def test_disconnect_is_not_signout(tmp_path):
    # Disconnecting Lichess drops only the OAuth token; it must not sign the user out
    # or touch repertoire ownership.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    a = app.repository.ensure_lichess_profile("alice")
    app.create_repertoire_payload("A rep", "white", owner_user_id=a)
    app.repository.set_profile_setting(a, "lichess.oauth", {"access_token": "t"})

    app.lichess_disconnect_payload(owner_user_id=a)

    assert app.lichess_status_payload(owner_user_id=a)["connected"] is False
    # The profile and its data are untouched.
    assert len(app.list_repertoires_payload(owner_user_id=a)["repertoires"]) == 1


# ---- HTTP cookie session ---------------------------------------------------


@contextmanager
def _running_app_server(app):
    handler = _handler_for_app(app)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:{0}".format(server.server_address[1])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _client():
    jar = http.cookiejar.CookieJar()
    return jar, urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def _get_json(opener, url):
    with opener.open(url) as response:
        return json.loads(response.read().decode("utf-8"))


def _post_json(opener, url, body):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with opener.open(request) as response:
        return json.loads(response.read().decode("utf-8"))


def test_http_two_browsers_get_isolated_repertoire_lists(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    with _running_app_server(app) as base:
        jar_a, client_a = _client()
        jar_b, client_b = _client()

        # Client A creates a repertoire; the response mints a session cookie.
        _post_json(client_a, base + "/api/repertoires/create", {"name": "A rep", "color": "white"})
        assert any(c.name == SESSION_COOKIE_NAME for c in jar_a)

        # A sees its repertoire; a brand-new browser B sees none.
        assert len(_get_json(client_a, base + "/api/repertoires")["repertoires"]) == 1
        assert len(_get_json(client_b, base + "/api/repertoires")["repertoires"]) == 0
        # B got its own distinct session cookie.
        assert any(c.name == SESSION_COOKIE_NAME for c in jar_b)
        a_token = next(c.value for c in jar_a if c.name == SESSION_COOKIE_NAME)
        b_token = next(c.value for c in jar_b if c.name == SESSION_COOKIE_NAME)
        assert a_token != b_token

        # A's session persists across requests (no new cookie needed) and stays scoped.
        assert _get_json(client_a, base + "/api/dashboard")["repertoires"] == 1
        assert _get_json(client_b, base + "/api/dashboard")["repertoires"] == 0


def test_http_signout_rotates_to_fresh_guest(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    with _running_app_server(app) as base:
        jar, client = _client()
        _post_json(client, base + "/api/repertoires/create", {"name": "mine", "color": "white"})
        assert len(_get_json(client, base + "/api/repertoires")["repertoires"]) == 1
        token_before = next(c.value for c in jar if c.name == SESSION_COOKIE_NAME)

        # Sign out rotates the session cookie to a brand-new guest.
        _post_json(client, base + "/api/auth/signout", {})
        token_after = next(c.value for c in jar if c.name == SESSION_COOKIE_NAME)
        assert token_after != token_before

        # The fresh guest sees none of the signed-out profile's data.
        assert len(_get_json(client, base + "/api/repertoires")["repertoires"]) == 0
        assert _get_json(client, base + "/api/dashboard")["repertoires"] == 0
