from prepforge_chess.core.models import MoveClassification
from prepforge_chess.services.analysis import (
    AnalysisCancelled,
    AnalysisConfig,
    AnalysisService,
    CancellationToken,
)
from prepforge_chess.services.brilliant import BrilliantResult
from prepforge_chess.services.engine import EngineAnalysisConfig, MockEngine
from prepforge_chess.services.pgn_import import PgnImportService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository


def _repository_with_game():
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    result = PgnImportService(repository).import_text(
        """
[Event "Analysis"]
[Site "https://lichess.org/analysis1"]
[Date "2026.05.25"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""
    )
    return repository, result.imported_game_ids[0]


def test_analysis_service_classifies_and_persists_moves():
    repository, game_id = _repository_with_game()
    service = AnalysisService(repository, engine=MockEngine())

    result = service.analyze_game_id(
        game_id,
        config=AnalysisConfig(engine=EngineAnalysisConfig(depth=8, multipv=1)),
    )

    assert result.engine == "mockfish"
    assert result.depth == 8
    assert len(result.move_results) == 6
    assert sum(result.summary.values()) == 6
    assert all(move.classification is not MoveClassification.UNKNOWN for move in result.move_results)
    assert all(move.engine_eval_before is not None for move in result.move_results)
    assert all(move.engine_eval_after is not None for move in result.move_results)
    assert all(move.best_move_uci for move in result.move_results)

    loaded = repository.load_game(game_id)
    assert loaded is not None
    assert loaded.moves[0].engine_eval_after is not None
    assert loaded.moves[0].classification is not MoveClassification.UNKNOWN

    latest = repository.load_latest_analysis_result(game_id)
    assert latest is not None
    assert latest.engine == "mockfish"
    assert latest.summary == result.summary


def test_analysis_can_run_without_persistence():
    repository, game_id = _repository_with_game()
    service = AnalysisService(repository, engine=MockEngine())

    result = service.analyze_game_id(game_id, config=AnalysisConfig(persist=False))

    assert len(result.move_results) == 6
    assert repository.load_latest_analysis_result(game_id) is None


def test_analysis_emits_progress_events():
    repository, game_id = _repository_with_game()
    service = AnalysisService(repository, engine=MockEngine())
    events = []

    result = service.analyze_game_id(
        game_id,
        config=AnalysisConfig(persist=False),
        progress_callback=events.append,
    )

    assert result.move_results
    assert events[0].phase == "started"
    assert events[-1].phase == "completed"
    assert events[-1].percent_complete == 1.0
    assert [event.phase for event in events].count("move_complete") == 6
    assert events[1].phase == "analyzing"
    assert events[1].current_ply == 1


def test_analysis_can_be_cancelled_from_progress_callback():
    repository, game_id = _repository_with_game()
    service = AnalysisService(repository, engine=MockEngine())
    token = CancellationToken()

    def cancel_after_second_move(progress):
        if progress.phase == "move_complete" and progress.current_ply == 2:
            token.cancel()

    try:
        service.analyze_game_id(
            game_id,
            config=AnalysisConfig(persist=True),
            progress_callback=cancel_after_second_move,
            cancel_token=token,
        )
    except AnalysisCancelled:
        pass
    else:
        raise AssertionError("expected AnalysisCancelled")

    assert repository.load_latest_analysis_result(game_id) is None


def test_parallel_analysis_preserves_move_order_and_classifies_all_moves():
    repository, game_id = _repository_with_game()
    created_engines = []

    def engine_factory():
        engine = MockEngine()
        created_engines.append(engine)
        return engine

    service = AnalysisService(
        repository,
        engine_factory=engine_factory,
        engine_name="mockfish",
    )
    result = service.analyze_game_id(
        game_id,
        config=AnalysisConfig(persist=False, max_workers=2),
    )

    assert len(created_engines) <= 2
    assert [move.ply for move in result.move_results] == [1, 2, 3, 4, 5, 6]
    assert all(move.classification is not MoveClassification.UNKNOWN for move in result.move_results)


def test_analysis_requires_brilliant_flag_before_promoting_classification():
    repository, game_id = _repository_with_game()

    class NonBrilliantAnalyzer:
        def evaluate(self, **kwargs):
            return BrilliantResult(
                is_brilliant=False,
                human_probability=0.5,
                maia_glance_wc=0.5,
                sf_truth_wc=0.5,
                sf_before_wc=0.5,
                reveal_score=0.0,
            )

    service = AnalysisService(
        repository,
        engine=MockEngine(),
        brilliant_analyzer=NonBrilliantAnalyzer(),
    )
    result = service.analyze_game_id(game_id, config=AnalysisConfig(persist=False))

    assert MoveClassification.BRILLIANT not in {
        move.classification for move in result.move_results
    }


def test_analysis_promotes_to_brilliant_when_analyzer_says_so():
    repository, game_id = _repository_with_game()

    class AlwaysBrilliantAnalyzer:
        def __init__(self):
            self.seen = []

        def evaluate(self, *, classification, **kwargs):
            self.seen.append(classification)
            return BrilliantResult(
                is_brilliant=True,
                human_probability=0.01,
                maia_glance_wc=0.3,
                sf_truth_wc=0.7,
                sf_before_wc=0.5,
                reveal_score=0.4,
            )

    analyzer = AlwaysBrilliantAnalyzer()
    service = AnalysisService(
        repository,
        engine=MockEngine(),
        brilliant_analyzer=analyzer,
    )
    result = service.analyze_game_id(game_id, config=AnalysisConfig(persist=False))

    assert all(
        c in {MoveClassification.BEST, MoveClassification.EXCELLENT}
        for c in analyzer.seen
    )
    assert MoveClassification.BRILLIANT in {
        move.classification for move in result.move_results
    }
