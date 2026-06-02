from prepforge_chess.cli import main
from prepforge_chess.services.game_navigation import GameNavigationService
from prepforge_chess.services.pgn_import import PgnImportService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository
from prepforge_chess.ui.terminal_viewer import TerminalBoardRenderer


def _navigation_state(ply: int):
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    result = PgnImportService(repository).import_text(
        """
[Event "Render"]
[Site "https://lichess.org/render1"]
[Date "2026.05.25"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""
    )
    return GameNavigationService(repository).state_for_game_id(result.imported_game_ids[0], ply=ply)


def test_terminal_renderer_outputs_board_and_current_move():
    state = _navigation_state(4)

    rendered = TerminalBoardRenderer().render(state)

    assert "PrepForge Chess" in rendered
    assert "Ply 4/6" in rendered
    assert "Last: b8c6" in rendered
    assert "Current: Nc6" in rendered
    assert "Next: Bb5" in rendered
    assert "1. e4 e5 2. Nf3 [Nc6] 3. Bb5 a6" in rendered


def test_demo_viewer_cli_renders_once(capsys):
    exit_code = main(["demo-viewer", "--ply", "4"])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "Ply 4/6" in captured.out
    assert "Last: b8c6" in captured.out


def test_analyze_demo_cli_runs_mock_pipeline(capsys):
    exit_code = main(["analyze-demo", "--depth", "8", "--progress", "--workers", "2"])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "progress: started" in captured.out
    assert "progress: completed" in captured.out
    assert "analysis: ok" in captured.out
    assert "engine: mockfish" in captured.out
    assert "workers: 2" in captured.out
    assert "Analysis Report" in captured.out
    assert "Eval:" in captured.out
    assert "moves:" in captured.out


def test_demo_build_cli_generates_tree(capsys):
    exit_code = main(["demo-build", "--depth", "2", "--max-nodes", "8", "--demo-operations"])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "build: ok" in captured.out
    assert "demo_operations:" in captured.out
    assert "added_nodes:" in captured.out
    assert "tree:" in captured.out
