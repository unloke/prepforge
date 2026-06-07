from contextlib import contextmanager
import json
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from stub_maia import StubMaia

from prepforge_chess.web import server as server_module
from prepforge_chess.web.server import (
    PrepForgeWebApp,
    ServerEngineDisabled,
    _dev_maia3_fallback,
    _handler_for_app,
)


def test_server_engine_disabled_by_default_blocks_engine_endpoints(tmp_path):
    # Hard product rule: the public/default flow must never run a server engine.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    assert app.server_engine_enabled is False

    # Every server-side compute entry point must refuse by default. This list is
    # the acceptance criteria for "server never carries the engine/model" — keep
    # it exhaustive so a new compute endpoint can't quietly skip the guard.
    with pytest.raises(ServerEngineDisabled):
        app.analyze_pgn_payload("1. e4 e5 *")
    with pytest.raises(ServerEngineDisabled):
        app.start_analysis_payload("1. e4 e5 *")
    with pytest.raises(ServerEngineDisabled):
        app.build_demo_payload()
    with pytest.raises(ServerEngineDisabled):
        app.build_generate_payload(repertoire_id="x", node_id="y")
    with pytest.raises(ServerEngineDisabled):
        app.start_build_generate_payload(repertoire_id="x", node_id="y")
    with pytest.raises(ServerEngineDisabled):
        app.engine_session_open_payload(
            fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        )
    with pytest.raises(ServerEngineDisabled):
        app.engine_session_update_payload(
            fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        )
    with pytest.raises(ServerEngineDisabled):
        app.install_stockfish_payload()
    with pytest.raises(ServerEngineDisabled):
        app.install_maia3_payload()

    # Non-compute engine-session calls stay available for cleanup.
    assert app.engine_session_snapshot_payload()["running"] is False


def test_crud_works_with_server_engine_disabled_and_no_maia(tmp_path):
    # P1 lock: ordinary build/edit (create/add-move/read/rename/delete) must work
    # in the public/default flow WITHOUT constructing a server Stockfish/Maia. It
    # uses inert metadata adapters, so this passes even where Maia3 isn't
    # installed — exercising it here proves CRUD never touches that dependency.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    assert app.server_engine_enabled is False

    created = app.create_repertoire_payload("My Repertoire", "white")
    repertoire_id = created["repertoire_id"]
    root_id = created["nodes"][0]["id"]

    added = app.build_add_move_payload(repertoire_id, root_id, "e2e4")
    assert added["selected_node_id"] != root_id

    workspace = app._build_workspace_payload(repertoire_id)
    assert workspace["nodes_total"] >= 2

    renamed = app.rename_repertoire_payload(repertoire_id, "Renamed")
    assert renamed["name"] == "Renamed"

    deleted = app.delete_repertoire_payload(repertoire_id)
    assert deleted["deleted"] == repertoire_id


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


def _post_status(base_url, path, body):
    request = urllib.request.Request(
        base_url + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


def test_http_compute_endpoints_return_403_when_disabled(tmp_path):
    # HTTP-layer lock: ServerEngineDisabled must surface as 403 on the wire for
    # the public compute endpoints, not a 200 or a 500.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    assert app.server_engine_enabled is False

    fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    with _running_app_server(app) as base_url:
        assert _post_status(base_url, "/api/engine/open", {"fen": fen}) == 403
        assert _post_status(base_url, "/api/analyze/pgn/start", {"pgn": "1. e4 e5 *"}) == 403
        assert (
            _post_status(
                base_url,
                "/api/build/generate/start",
                {"repertoire_id": "x", "node_id": "y"},
            )
            == 403
        )


def _get_text(base_url, path):
    with urllib.request.urlopen(base_url + path) as response:
        return response.status, response.read().decode("utf-8")


def test_index_html_omits_asset_base_when_env_unset(tmp_path, monkeypatch):
    # Default/local flow: with no runtime CDN knob, the browser bundle keeps its
    # in-image /static/maia3/ fallback, so the server must inject nothing.
    monkeypatch.delenv("PREPFORGE_MAIA3_ASSET_BASE", raising=False)
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    with _running_app_server(app) as base_url:
        status, body = _get_text(base_url, "/")
    assert status == 200
    assert "__MAIA3_ASSET_BASE" not in body


def test_html_injects_runtime_asset_base_from_env(tmp_path, monkeypatch):
    # Production seam (P1): the ONNX weights are CDN-hosted and never in the deploy
    # image, so a committed-static deploy sets PREPFORGE_MAIA3_ASSET_BASE and the
    # server renders window.__MAIA3_ASSET_BASE into the served HTML -- the browser
    # engine then fetches weights from the CDN with NO rebuild. The injection is
    # page-agnostic (_inject_asset_base rewrites any served HTML), so we assert it on the
    # deploy-shipped app shell, right after <head> (before any module script reads the
    # global). The maia3 diagnostic pages are dev-only now (vite harnessInputs,
    # MAIA3_HARNESS=1) and aren't in the deploy build, so they aren't asserted here.
    cdn = "https://cdn.example.com/maia3/"
    monkeypatch.setenv("PREPFORGE_MAIA3_ASSET_BASE", cdn)
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    with _running_app_server(app) as base_url:
        _, index_body = _get_text(base_url, "/")
    expected = '<script>window.__MAIA3_ASSET_BASE="{0}";</script>'.format(cdn)
    assert "<head>" + expected in index_body


def test_dev_maia3_fallback_resolves_only_safe_maia_files(tmp_path, monkeypatch):
    # A production build strips the ONNX weights from static/maia3/ (CDN-hosted), so
    # local runs fall back to the developer's source copy. The resolver must accept a
    # real maia3 file, but reject non-maia paths, missing files, and traversal.
    dev_dir = tmp_path / "public-maia3"
    dev_dir.mkdir()
    (dev_dir / "maia3-fp16-abc.onnx").write_bytes(b"weightbytes")
    monkeypatch.setattr(server_module, "DEV_MAIA3_DIR", dev_dir)

    hit = _dev_maia3_fallback("maia3/maia3-fp16-abc.onnx")
    assert hit is not None and hit.read_bytes() == b"weightbytes"
    assert _dev_maia3_fallback("maia3/missing.onnx") is None  # not present
    assert _dev_maia3_fallback("engine/ort/x.wasm") is None  # not a maia3 path
    assert _dev_maia3_fallback("maia3/../../secret") is None  # traversal guard


def test_dev_maia3_fallback_disabled_when_source_dir_absent(tmp_path, monkeypatch):
    # In a pip-installed deploy there is no web-src/, so the fallback dir doesn't exist
    # and the resolver no-ops (production serves weights from the CDN asset base).
    monkeypatch.setattr(server_module, "DEV_MAIA3_DIR", tmp_path / "does-not-exist")
    assert _dev_maia3_fallback("maia3/maia3-fp16-abc.onnx") is None


def test_static_maia3_weight_served_from_dev_fallback(tmp_path, monkeypatch):
    # End-to-end over HTTP: a maia3 weight absent from static/ but present in the dev
    # source dir is served (200) via the fallback, so local Maia3 "just works".
    dev_dir = tmp_path / "public-maia3"
    dev_dir.mkdir()
    (dev_dir / "maia3-fp16-served.onnx").write_bytes(b"\x00\x01\x02onnx")
    monkeypatch.setattr(server_module, "DEV_MAIA3_DIR", dev_dir)

    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    with _running_app_server(app) as base_url:
        with urllib.request.urlopen(
            base_url + "/static/maia3/maia3-fp16-served.onnx"
        ) as response:
            assert response.status == 200
            assert response.read() == b"\x00\x01\x02onnx"
        # A genuinely missing weight is still a 404.
        try:
            urllib.request.urlopen(base_url + "/static/maia3/nope.onnx")
            assert False, "expected 404"
        except urllib.error.HTTPError as exc:
            assert exc.code == 404


def test_web_dashboard_and_board_payload(tmp_path):
    app = PrepForgeWebApp(
        db_path=tmp_path / "ui.sqlite3",
        prefer_real_engines=False,
        server_engine_enabled=True,
    )

    dashboard = app.dashboard_payload()
    board = app.board_payload("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
    moved = app.board_move_payload(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "e2e4",
    )

    assert dashboard["games"] == 0
    assert dashboard["repertoires"] == 0
    assert dashboard["recommendations"]
    assert board["side_to_move"] == "white"
    assert "e2e4" in board["legal_moves"]
    assert moved["move"]["san"] == "e4"
    assert moved["board"]["side_to_move"] == "black"
    assert "e7e5" in moved["board"]["legal_moves"]


def test_web_analysis_history_lists_and_recalls(tmp_path):
    app = PrepForgeWebApp(
        db_path=tmp_path / "ui.sqlite3",
        prefer_real_engines=False,
        server_engine_enabled=True,
    )
    app.analyze_pgn_payload(
        """
[Event "History Game"]
[Site "https://lichess.org/histgame1"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""
    )

    listed = app.list_analyses_payload()
    assert len(listed["analyses"]) == 1
    entry = listed["analyses"][0]
    assert entry["white"] == "Alice"
    assert entry["black"] == "Bob"

    recalled = app.analysis_recall_payload(entry["game_id"])
    assert recalled["game_id"] == entry["game_id"]
    assert recalled["moves"]
    assert recalled["moves"][0]["san"] == "e4"


def test_web_analyze_and_build_demo_payloads(tmp_path):
    app = PrepForgeWebApp(
        db_path=tmp_path / "ui.sqlite3",
        prefer_real_engines=False,
        server_engine_enabled=True,
        maia_factory=StubMaia,
    )

    analysis = app.analyze_pgn_payload(
        """
[Event "Web PGN"]
[Site "https://lichess.org/webpgn1"]
[White "Alice"]
[Black "Bob"]
[Result "*"]

1. d4 Nf6 2. c4 e6 *
"""
    )
    build = app.build_demo_payload()

    assert analysis["engine"] == "mockfish"
    assert len(analysis["moves"]) == 4
    assert analysis["moves"][0]["san"] == "d4"
    assert analysis["moves"][0]["classification"] != "unknown"
    assert analysis["eval_graph"]
    repeated = app.analyze_pgn_payload(
        """
[Event "Web PGN"]
[Site "https://lichess.org/webpgn1"]
[White "Alice"]
[Black "Bob"]
[Result "*"]

1. d4 Nf6 2. c4 e6 *
"""
    )
    assert repeated["game_id"] == analysis["game_id"]

    assert build["summary"]["added_nodes"] > 0
    assert build["nodes_total"] > 1
    assert any(node["is_prepared"] for node in build["nodes"])
    assert build["selected_fen"]
    assert "fen" in build["nodes"][0]


def test_web_analysis_job_reports_progress_and_result(tmp_path):
    app = PrepForgeWebApp(
        db_path=tmp_path / "ui.sqlite3",
        prefer_real_engines=False,
        server_engine_enabled=True,
    )

    started = app.start_analysis_payload(
        """
[Event "Async Web PGN"]
[Site "https://lichess.org/webpgn2"]
[White "Alice"]
[Black "Bob"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *
"""
    )

    deadline = time.time() + 5
    status = started
    while time.time() < deadline:
        status = app.analysis_status_payload(started["job_id"])
        if status["status"] == "completed":
            break
        time.sleep(0.05)

    assert status["status"] == "completed"
    assert status["percent"] == 1.0
    assert status["result"]["engine"] == "mockfish"
    assert len(status["result"]["moves"]) == 4


def test_web_build_can_add_generate_export_and_import_repertoire(tmp_path):
    app = PrepForgeWebApp(
        db_path=tmp_path / "ui.sqlite3",
        prefer_real_engines=False,
        server_engine_enabled=True,
        maia_factory=StubMaia,
    )

    build = app.build_demo_payload()
    root_id = build["nodes"][0]["id"]
    added = app.build_add_move_payload(build["repertoire_id"], root_id, "g1f3")
    generated = app.build_generate_payload(
        added["repertoire_id"],
        added["selected_node_id"],
        ply_depth=1,
        detail_mode="balanced",
    )
    marked = app.build_node_action_payload(
        generated["repertoire_id"],
        generated["selected_node_id"],
        "mark_critical",
    )
    exported = app.build_export_payload(marked["repertoire_id"], "json")
    imported = app.import_repertoire_payload(exported["content"])

    assert added["selected_node_id"] != root_id
    assert generated["nodes_total"] >= added["nodes_total"]
    assert any("critical" in node["tags"] for node in marked["nodes"])
    assert exported["filename"].endswith(".prepforge.json")
    assert imported["repertoire_id"] == marked["repertoire_id"]


def test_web_can_start_training_from_imported_repertoire(tmp_path):
    app = PrepForgeWebApp(
        db_path=tmp_path / "ui.sqlite3",
        prefer_real_engines=False,
        server_engine_enabled=True,
        maia_factory=StubMaia,
    )

    build = app.build_demo_payload()
    exported = app.build_export_payload(build["repertoire_id"], "json")
    imported = app.import_repertoire_payload(exported["content"])
    started = app.start_training_payload(imported["repertoire_id"], seed=7)

    assert started["repertoire_id"] == imported["repertoire_id"]
    assert started["lines"]
    assert "expected_move_uci" not in started["prompt"]


def _seed_browser_evals(prep, *, score_cp=20, best_is_played=True, overrides=None):
    """Build a classify-save `positions` payload from a prepare() result.

    Mimics what the browser sends: one eval per position. By default every
    position scores `score_cp` and names the played move as best (→ all "best").
    `overrides` maps a position index to a dict patched onto that position.
    """
    played_by_fen = {m["fen_before"]: m["uci"] for m in prep["moves"]}
    positions = []
    for index, fen in enumerate(prep["positions"]):
        item = {
            "fen": fen,
            "score_cp": score_cp,
            "mate_in": None,
            "best_move_uci": played_by_fen.get(fen) if best_is_played else None,
            "pv": [],
        }
        if overrides and index in overrides:
            item.update(overrides[index])
        positions.append(item)
    return positions


def test_browser_analysis_prepare_and_classify_save_default_off(tmp_path):
    # Phase 2: whole-game analysis runs in the browser; the server only parses
    # the PGN and classifies/persists the supplied evals — no engine. So both
    # endpoints must work in the public/default flow (server engine disabled).
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    assert app.server_engine_enabled is False

    prep = app.prepare_analysis_payload(
        """
[Event "Browser PGN"]
[Site "https://lichess.org/browserpgn1"]
[White "Alice"]
[Black "Bob"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *
"""
    )
    assert len(prep["moves"]) == 4
    # positions = every fen_before plus the final fen_after = plies + 1.
    assert len(prep["positions"]) == 5
    assert prep["positions"][-1] == prep["moves"][-1]["fen_after"]

    positions = _seed_browser_evals(prep, score_cp=20)
    payload = app.classify_save_payload(
        game_id=prep["game_id"], depth=12, positions=positions
    )
    assert payload["engine"] == "stockfish (browser)"
    assert payload["depth"] == 12
    assert len(payload["moves"]) == 4
    # Equal evals + best == played ⇒ every move is "best".
    assert all(m["classification"] == "best" for m in payload["moves"])
    assert payload["eval_graph"]
    assert "summary" in payload and "critical_moments" in payload


def test_browser_analysis_classifies_blunder_persists_and_recalls(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    prep = app.prepare_analysis_payload("1. e4 e5 2. Nf3 Nc6 *")

    # Make White's first move a blunder: the best line (a different move) is
    # winning for White (+1000), but after the move played White is lost
    # (the next position evaluates to -1000 White-POV).
    positions = _seed_browser_evals(
        prep,
        score_cp=0,
        overrides={
            0: {"score_cp": 1000, "best_move_uci": "d2d4"},  # fen_before(ply 1)
            1: {"score_cp": -1000},                          # fen_before(ply 2) = after e4
        },
    )
    payload = app.classify_save_payload(game_id=prep["game_id"], positions=positions)
    assert payload["moves"][0]["classification"] == "blunder"

    # Persisted: shows up in history and recalls with the same classification.
    listed = app.list_analyses_payload()["analyses"]
    assert any(a["game_id"] == prep["game_id"] for a in listed)
    recalled = app.analysis_recall_payload(prep["game_id"])
    assert recalled["moves"][0]["classification"] == "blunder"


def test_prepare_reanalyze_resolves_to_existing_game(tmp_path):
    # Re-analyzing the same (non-lichess) PGN must resolve to the already-stored
    # game, not a fresh unsaved id — otherwise prepare 400s on the second run.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    pgn = "1. e4 e5 2. Nf3 Nc6 *"
    first = app.prepare_analysis_payload(pgn)
    second = app.prepare_analysis_payload(pgn)
    assert second["game_id"] == first["game_id"]
    # The resolved id is loadable (would have raised "game not found" otherwise).
    assert second["positions"] == first["positions"]


def test_browser_analysis_missing_position_eval_errors(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    prep = app.prepare_analysis_payload("1. e4 e5 2. Nf3 Nc6 *")
    positions = _seed_browser_evals(prep)
    # Drop a required position — incomplete client payload must fail loudly.
    del positions[1]
    with pytest.raises(ValueError):
        app.classify_save_payload(game_id=prep["game_id"], positions=positions)


@pytest.mark.parametrize(
    "bad_positions",
    [
        None,
        "not-a-list",
        {"fen": "x"},          # an object, not a list
        [123],                 # list of non-objects
        ["e4"],                # list of strings
        [{"score_cp": 1}],     # object without a fen
    ],
)
def test_classify_save_rejects_malformed_positions(tmp_path, bad_positions):
    # Malformed `positions` must be a clean 400 (ValueError), never a 500.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    prep = app.prepare_analysis_payload("1. e4 e5 *")
    with pytest.raises(ValueError):
        app.classify_save_payload(game_id=prep["game_id"], positions=bad_positions)


def test_http_classify_save_malformed_positions_returns_400(tmp_path):
    # At the HTTP boundary, malformed input is a 400, not a 500.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    prep = app.prepare_analysis_payload("1. e4 e5 *")
    with _running_app_server(app) as base_url:
        status = _post_status(
            base_url,
            "/api/analyze/classify-save",
            {"game_id": prep["game_id"], "positions": "not-a-list"},
        )
        assert status == 400


def test_prepare_advertises_brilliant_rating_for_the_browser(tmp_path):
    # Phase 3d: the browser must compute its Brilliant move_assessment at the rating
    # the server's BrilliantAnalyzer expects, so prepare() advertises it.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    prep = app.prepare_analysis_payload("1. e4 e5 *")
    assert prep["brilliant"]["enabled"] is True
    assert prep["brilliant"]["rating"] == 1900


def test_browser_brilliant_flagged_from_client_maia_assessment(tmp_path):
    # Phase 3d: with a browser-supplied Maia assessment, a Best move that is
    # unintuitive (low human prob), looks bad at a glance (low maia win-chance) but is
    # objectively winning (high Stockfish truth) is upgraded to BRILLIANT — server runs
    # NO Maia (ReplayMaia replays the client numbers into the validated analyzer).
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    assert app.server_engine_enabled is False
    prep = app.prepare_analysis_payload("1. e4 *")
    start_fen = prep["moves"][0]["fen_before"]

    # +300cp everywhere ⇒ e2e4 is Best and the truth win-chance ≈ 0.75 (sound).
    positions = _seed_browser_evals(prep, score_cp=300)
    payload = app.classify_save_payload(
        game_id=prep["game_id"],
        positions=positions,
        maia_assessments=[
            {"fen": start_fen, "uci": "e2e4", "human_probability": 0.02, "win_chance_after": 0.10},
        ],
    )
    assert payload["moves"][0]["classification"] == "brilliant"
    # Persisted as brilliant too.
    recalled = app.analysis_recall_payload(prep["game_id"])
    assert recalled["moves"][0]["classification"] == "brilliant"


def test_browser_intuitive_move_not_brilliant(tmp_path):
    # Same winning Best move, but a HIGH human probability (intuitive) ⇒ not Brilliant.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    prep = app.prepare_analysis_payload("1. e4 *")
    start_fen = prep["moves"][0]["fen_before"]
    positions = _seed_browser_evals(prep, score_cp=300)
    payload = app.classify_save_payload(
        game_id=prep["game_id"],
        positions=positions,
        maia_assessments=[
            {"fen": start_fen, "uci": "e2e4", "human_probability": 0.80, "win_chance_after": 0.10},
        ],
    )
    assert payload["moves"][0]["classification"] == "best"


def test_browser_no_maia_assessments_means_no_brilliant(tmp_path):
    # Omitting maia_assessments keeps the Phase-2 behaviour: no Brilliant detection.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    prep = app.prepare_analysis_payload("1. e4 *")
    positions = _seed_browser_evals(prep, score_cp=300)
    payload = app.classify_save_payload(game_id=prep["game_id"], positions=positions)
    assert payload["moves"][0]["classification"] == "best"


@pytest.mark.parametrize(
    "bad",
    [
        "not-a-list",
        [123],                                                            # non-object item
        [{"uci": "e2e4", "human_probability": 0.1, "win_chance_after": 0.1}],  # no fen
        [{"fen": "x", "human_probability": 0.1, "win_chance_after": 0.1}],     # no uci
        [{"fen": "x", "uci": "e2e4", "human_probability": 1.5, "win_chance_after": 0.1}],  # >1
        [{"fen": "x", "uci": "e2e4", "human_probability": 0.1, "win_chance_after": -0.1}], # <0
        [{"fen": "x", "uci": "e2e4", "human_probability": "lo", "win_chance_after": 0.1}], # non-number
    ],
)
def test_classify_save_rejects_malformed_maia_assessments(tmp_path, bad):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    prep = app.prepare_analysis_payload("1. e4 *")
    positions = _seed_browser_evals(prep, score_cp=300)
    with pytest.raises(ValueError):
        app.classify_save_payload(
            game_id=prep["game_id"], positions=positions, maia_assessments=bad
        )


def test_browser_analysis_handles_checkmate_pgn(tmp_path):
    # A PGN that ends in checkmate puts a terminal (game-over) position in the
    # positions list. The server must classify + persist it end-to-end (the
    # browser supplies a decisive eval for that final position).
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    prep = app.prepare_analysis_payload(
        "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0"
    )
    assert len(prep["moves"]) == 7
    # The final position (after Qxf7#) is checkmate and must be in positions.
    assert prep["positions"][-1] == prep["moves"][-1]["fen_after"]

    positions = _seed_browser_evals(prep)
    # Black is checkmated in the final position → decisive for White.
    positions[-1]["score_cp"] = 100000
    payload = app.classify_save_payload(game_id=prep["game_id"], positions=positions)
    assert len(payload["moves"]) == 7
    recalled = app.analysis_recall_payload(prep["game_id"])
    assert len(recalled["moves"]) == 7


def test_web_training_demo_accepts_wrong_then_correct_move(tmp_path):
    app = PrepForgeWebApp(
        db_path=tmp_path / "ui.sqlite3",
        prefer_real_engines=False,
        server_engine_enabled=True,
    )

    started = app.start_training_demo_payload(seed=5)
    prompt = started["prompt"]

    assert "expected_move_uci" not in prompt
    assert "expected_move_san" not in prompt
    assert "line_san" not in prompt
    assert "san" not in started["lines"][0]
    assert "uci" not in started["lines"][0]

    wrong = app.submit_training_move_payload(started["session_id"], "a1a1")
    correct = app.submit_training_move_payload(
        started["session_id"],
        wrong["expected_uci"],
    )

    assert not wrong["correct"]
    assert len(wrong["mistakes"]) == 1
    assert wrong["prompt"] is not None
    assert "expected_move_uci" not in wrong["prompt"]

    assert correct["correct"]
    assert correct["mistakes"] == []
    assert correct["prompt"] is not None
    assert "expected_move_uci" not in correct["prompt"]


def _post_json(base_url, path, body):
    request = urllib.request.Request(
        base_url + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, None


def test_build_apply_plan_runs_with_server_engine_disabled(tmp_path):
    # Phase 3c: the browser ran both engines and submits a tree-mutation plan.
    # apply-plan runs NO compute, so it must succeed in the public/default flow
    # (server engine disabled, no Maia) — the server only re-validates + persists.
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    assert app.server_engine_enabled is False

    created = app.create_repertoire_payload("Plan", "white")
    repertoire_id = created["repertoire_id"]
    root_id = created["nodes"][0]["id"]

    plan = {
        "rootNodeId": root_id,
        "changes": [
            {
                "action": "planned_add",
                "tempId": "tmp-1",
                "parentRef": root_id,
                "moveUci": "e2e4",
                "source": "generated_stockfish",
                "intendedMainline": True,
                "engineEvaluation": {
                    "engine": "stockfish (browser)",
                    "depth": 8,
                    "score_cp": 30,
                    "mate_in": None,
                    "best_move_uci": "e2e4",
                    "pv": ["e2e4"],
                    "wdl": None,
                },
            }
        ],
    }

    with _running_app_server(app) as base_url:
        status, body = _post_json(
            base_url,
            "/api/build/generate/apply-plan",
            {"repertoire_id": repertoire_id, "root_node_id": root_id, "plan": plan},
        )
        assert status == 200
        assert body["summary"]["added_nodes"] == 1
        assert any(node.get("uci") == "e2e4" for node in body["nodes"])

        # An illegal move in the plan must surface as a 400, not a 500 or 200.
        bad_plan = {
            "changes": [
                {
                    "action": "planned_add",
                    "tempId": "tmp-1",
                    "parentRef": root_id,
                    "moveUci": "e2e5",  # illegal from the start position
                    "source": "generated_stockfish",
                    "intendedMainline": True,
                }
            ]
        }
        bad_status, _ = _post_json(
            base_url,
            "/api/build/generate/apply-plan",
            {"repertoire_id": repertoire_id, "root_node_id": root_id, "plan": bad_plan},
        )
        assert bad_status == 400


def test_build_apply_plan_rejects_too_many_changes_over_http(tmp_path):
    # apply-plan is public + untrusted: an oversized plan (too many changes) must
    # be refused at the HTTP boundary (400), never applied unbounded. (The body
    # Content-Length cap in _read_json is a separate defensive layer; it's not
    # exercised over a real socket here because rejecting before draining a >2 MB
    # body would race the client's upload — it's covered by review + the constant.)
    from prepforge_chess.services.opening_builder import MAX_PLAN_CHANGES

    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    created = app.create_repertoire_payload("Plan", "white")
    repertoire_id = created["repertoire_id"]
    root_id = created["nodes"][0]["id"]

    with _running_app_server(app) as base_url:
        too_many = {
            "changes": [
                {
                    "action": "planned_add",
                    "tempId": "tmp-{0}".format(i),
                    "parentRef": root_id,
                    "moveUci": "e2e4",
                    "source": "generated_stockfish",
                    "intendedMainline": True,
                }
                for i in range(MAX_PLAN_CHANGES + 1)
            ]
        }
        status, _ = _post_json(
            base_url,
            "/api/build/generate/apply-plan",
            {"repertoire_id": repertoire_id, "root_node_id": root_id, "plan": too_many},
        )
        assert status == 400

    # Nothing from the rejected plan was persisted.
    workspace = app._build_workspace_payload(repertoire_id)
    assert workspace["nodes_total"] == 1  # root only
