from prepforge_chess.core.models import MoveClassification
from prepforge_chess.services.browser_compute import classify_precomputed_game
from prepforge_chess.services.analysis_report import AnalysisReportBuilder
from prepforge_chess.services.pgn_import import PgnImportService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository


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
    game = repository.load_game(import_result.imported_game_ids[0])
    positions = {fen: {"depth": 10, "score_cp": 20} for move in game.moves
                 for fen in (move.fen_before, move.fen_after)}
    return classify_precomputed_game(game, positions, engine_name="test", depth=10)


def test_analysis_report_builds_eval_graph_and_jump_targets():
    result = _analysis_result()
    result.move_results[4].classification = MoveClassification.INACCURACY
    result.move_results[4].comment = "clear but recoverable drop"

    report = AnalysisReportBuilder().build(result)

    assert len(report.eval_graph) == 6
    assert report.eval_graph[0].ply == 1
    assert report.critical_moments[0].ply == 5
    assert report.jump_plies == [5]


def test_analysis_payload_eval_graph_carries_mate_distance():
    from dataclasses import replace

    from prepforge_chess.services.analysis_view import analysis_result_to_payload

    result = _analysis_result()
    last = result.move_results[-1]
    last.engine_eval_after = replace(last.engine_eval_after, score_cp=None, mate_in=2)

    graph = analysis_result_to_payload(result)["eval_graph"]

    # The chart labels a forced mate "#2"; without mate_in it could only say "+M".
    assert graph[-1]["mate_in"] == 2
    assert graph[-1]["bounded_score_cp"] == 1000
    assert graph[0]["mate_in"] is None
