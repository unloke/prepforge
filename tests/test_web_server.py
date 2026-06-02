from prepforge_chess.web.server import PrepForgeWebApp
import time


def test_web_dashboard_and_board_payload(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)

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
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
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
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)

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
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)

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
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)

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
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)

    build = app.build_demo_payload()
    exported = app.build_export_payload(build["repertoire_id"], "json")
    imported = app.import_repertoire_payload(exported["content"])
    started = app.start_training_payload(imported["repertoire_id"], seed=7)

    assert started["repertoire_id"] == imported["repertoire_id"]
    assert started["lines"]
    assert "expected_move_uci" not in started["prompt"]


def test_web_training_demo_accepts_wrong_then_correct_move(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)

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
