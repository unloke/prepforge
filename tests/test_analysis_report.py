from prepforge_chess.core.models import MoveClassification
from prepforge_chess.services.analysis import AnalysisConfig, AnalysisService
from prepforge_chess.services.analysis_report import AnalysisReportBuilder
from prepforge_chess.services.engine import MockEngine
from prepforge_chess.services.pgn_import import PgnImportService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository
from prepforge_chess.ui.analysis_terminal import TerminalAnalysisRenderer


def _analysis_result():
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    import_result = PgnImportService(repository).import_text(
        """
[Event "Report"]
[Site "https://lichess.org/report1"]
[Date "2026.05.25"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""
    )
    service = AnalysisService(repository, engine=MockEngine())
    return service.analyze_game_id(import_result.imported_game_ids[0], config=AnalysisConfig(persist=False))


def test_analysis_report_builds_eval_graph_and_jump_targets():
    result = _analysis_result()
    result.move_results[4].classification = MoveClassification.INACCURACY
    result.move_results[4].comment = "clear but recoverable drop"

    report = AnalysisReportBuilder().build(result)

    assert len(report.eval_graph) == 6
    assert report.eval_graph[0].ply == 1
    assert report.critical_moments[0].ply == 5
    assert report.jump_plies == [5]


def test_terminal_analysis_renderer_outputs_report_sections():
    result = _analysis_result()
    result.move_results[4].classification = MoveClassification.INACCURACY

    report = AnalysisReportBuilder().build(result)
    rendered = TerminalAnalysisRenderer().render(report)

    assert "Analysis Report" in rendered
    assert "Engine: mockfish" in rendered
    assert "Eval:" in rendered
    assert "Jump: 5" in rendered
    assert "Key Moments:" in rendered
