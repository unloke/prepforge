from __future__ import annotations

from collections import Counter
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from copy import deepcopy
from dataclasses import dataclass
import threading
from typing import Callable, Dict, List, Optional

from prepforge_chess.core.models import AnalysisResult, Game, MoveClassification, utc_now
from prepforge_chess.services.brilliant import (
    BRILLIANT_ELIGIBLE_CLASSIFICATIONS,
    BrilliantAnalyzer,
    BrilliantConfig,
)
from prepforge_chess.services.classification import (
    ClassificationConfig,
    classify_move,
)
from prepforge_chess.services.engine import EngineAdapter, EngineAnalysisConfig, MockEngine
from prepforge_chess.storage.repositories import PrepForgeRepository


@dataclass(frozen=True)
class AnalysisConfig:
    engine: EngineAnalysisConfig = EngineAnalysisConfig()
    classification: ClassificationConfig = ClassificationConfig()
    brilliant: BrilliantConfig = BrilliantConfig()
    persist: bool = True
    max_workers: int = 1


@dataclass(frozen=True)
class AnalysisProgress:
    game_id: str
    phase: str
    current_ply: int
    total_plies: int
    san: Optional[str] = None
    classification: Optional[MoveClassification] = None
    message: Optional[str] = None

    @property
    def percent_complete(self) -> float:
        if self.total_plies <= 0:
            return 1.0
        return min(1.0, max(0.0, self.current_ply / self.total_plies))


class AnalysisCancelled(RuntimeError):
    pass


class CancellationToken:
    def __init__(self) -> None:
        self._cancelled = False

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled

    def cancel(self) -> None:
        self._cancelled = True

    def raise_if_cancelled(self) -> None:
        if self._cancelled:
            raise AnalysisCancelled("Analysis cancelled.")


ProgressCallback = Callable[[AnalysisProgress], None]
EngineFactory = Callable[[], EngineAdapter]


class AnalysisService:
    def __init__(
        self,
        repository: PrepForgeRepository,
        engine: Optional[EngineAdapter] = None,
        engine_factory: Optional[EngineFactory] = None,
        engine_name: Optional[str] = None,
        brilliant_analyzer: Optional[BrilliantAnalyzer] = None,
    ):
        self.repository = repository
        self.engine = engine if engine is not None else (MockEngine() if engine_factory is None else None)
        self.engine_factory = engine_factory
        self.engine_name = engine_name or (self.engine.name if self.engine is not None else "engine")
        self.brilliant_analyzer = brilliant_analyzer

    def analyze_game_id(
        self,
        game_id: str,
        config: AnalysisConfig = AnalysisConfig(),
        progress_callback: Optional[ProgressCallback] = None,
        cancel_token: Optional[CancellationToken] = None,
    ) -> AnalysisResult:
        game = self.repository.load_game(game_id)
        if game is None:
            raise ValueError("game not found: {0}".format(game_id))
        return self.analyze_game(
            game,
            config=config,
            progress_callback=progress_callback,
            cancel_token=cancel_token,
        )

    def analyze_game(
        self,
        game: Game,
        config: AnalysisConfig = AnalysisConfig(),
        progress_callback: Optional[ProgressCallback] = None,
        cancel_token: Optional[CancellationToken] = None,
    ) -> AnalysisResult:
        critical: List[int] = []
        token = cancel_token or CancellationToken()
        total_plies = len(game.moves)

        self._emit_progress(
            progress_callback,
            token,
            AnalysisProgress(
                game_id=game.id,
                phase="started",
                current_ply=0,
                total_plies=total_plies,
                message="analysis started",
            ),
        )

        if config.max_workers <= 1:
            self._analyze_game_sequential(game, config, progress_callback, token)
        else:
            self._analyze_game_parallel(game, config, progress_callback, token)

        critical = [
            move.ply
            for move in game.moves
            if move.classification
            in {
                MoveClassification.BRILLIANT,
                MoveClassification.MISTAKE,
                MoveClassification.BLUNDER,
                MoveClassification.MISSED_WIN,
                MoveClassification.MISSED_TACTIC,
            }
        ]

        summary = Counter(move.classification.value for move in game.moves)
        result = AnalysisResult(
            game_id=game.id,
            analyzed_at=utc_now(),
            engine=self.engine_name,
            depth=config.engine.depth,
            move_results=game.moves,
            summary=dict(summary),
            critical_ply=critical,
        )

        if config.persist:
            self.repository.save_game(game)
            self.repository.save_analysis_result(result)

        self._emit_progress(
            progress_callback,
            token,
            AnalysisProgress(
                game_id=game.id,
                phase="completed",
                current_ply=total_plies,
                total_plies=total_plies,
                message="analysis completed",
            ),
        )

        return result

    def _analyze_game_sequential(
        self,
        game: Game,
        config: AnalysisConfig,
        progress_callback: Optional[ProgressCallback],
        token: CancellationToken,
    ) -> None:
        engine = self.engine
        close_engine = False
        if engine is None:
            engine = self._create_worker_engine()
            close_engine = True

        try:
            for index, move in enumerate(game.moves):
                token.raise_if_cancelled()
                self._emit_analyzing_progress(progress_callback, token, game.id, move, len(game.moves))
                previous_move = deepcopy(game.moves[index - 1]) if index > 0 else None
                analyzed = self._analyze_move(deepcopy(move), previous_move, engine, config)
                game.moves[index] = analyzed
                self._emit_move_complete_progress(
                    progress_callback,
                    token,
                    game.id,
                    analyzed,
                    len(game.moves),
                )
        finally:
            if close_engine:
                self._close_engine(engine)

    def _analyze_game_parallel(
        self,
        game: Game,
        config: AnalysisConfig,
        progress_callback: Optional[ProgressCallback],
        token: CancellationToken,
    ) -> None:
        if self.engine_factory is None:
            raise ValueError("Parallel analysis requires an engine_factory.")

        worker_count = max(1, config.max_workers)
        local_state = threading.local()
        engines: List[EngineAdapter] = []
        engines_lock = threading.Lock()
        futures: Dict[Future, int] = {}
        next_index = 0
        completed_count = 0

        def engine_for_thread() -> EngineAdapter:
            if not hasattr(local_state, "engine"):
                engine = self._create_worker_engine()
                local_state.engine = engine
                with engines_lock:
                    engines.append(engine)
            return local_state.engine

        def worker(index: int):
            token.raise_if_cancelled()
            previous_move = deepcopy(game.moves[index - 1]) if index > 0 else None
            return index, self._analyze_move(
                deepcopy(game.moves[index]),
                previous_move,
                engine_for_thread(),
                config,
            )

        def submit_next(executor: ThreadPoolExecutor) -> bool:
            nonlocal next_index
            if next_index >= len(game.moves):
                return False
            token.raise_if_cancelled()
            move = game.moves[next_index]
            self._emit_analyzing_progress(progress_callback, token, game.id, move, len(game.moves))
            futures[executor.submit(worker, next_index)] = next_index
            next_index += 1
            return True

        try:
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                for _ in range(min(worker_count, len(game.moves))):
                    submit_next(executor)

                while futures:
                    token.raise_if_cancelled()
                    done, _ = wait(list(futures.keys()), return_when=FIRST_COMPLETED)
                    for future in done:
                        futures.pop(future)
                        index, analyzed = future.result()
                        game.moves[index] = analyzed
                        completed_count += 1
                        self._emit_move_complete_progress(
                            progress_callback,
                            token,
                            game.id,
                            analyzed,
                            len(game.moves),
                            completed_plies=completed_count,
                        )
                        submit_next(executor)
        except AnalysisCancelled:
            for future in futures:
                future.cancel()
            raise
        finally:
            for engine in engines:
                self._close_engine(engine)

    def _analyze_move(
        self,
        move,
        previous_move,
        engine: EngineAdapter,
        config: AnalysisConfig,
    ):
        del previous_move  # Brilliant detection no longer needs prior context.

        position_analysis = engine.analyze_position(move.fen_before, config.engine)
        played_eval_after = engine.evaluate_position(move.fen_after, config.engine)
        best_eval_after = position_analysis.best_evaluation_after or played_eval_after

        move.engine_eval_before = position_analysis.evaluation
        move.engine_eval_after = played_eval_after
        move.best_move_uci = position_analysis.best_move_uci
        move.best_move_eval = best_eval_after

        classification = classify_move(
            side_to_move=move.side_to_move,
            played_move_uci=move.uci,
            best_move_uci=move.best_move_uci,
            played_eval_after=played_eval_after,
            best_eval_after=best_eval_after,
            config=config.classification,
        )
        move.classification = classification.classification
        comment = classification.reason

        brilliant_result = None
        if (
            self.brilliant_analyzer is not None
            and move.classification in BRILLIANT_ELIGIBLE_CLASSIFICATIONS
        ):
            brilliant_result = self.brilliant_analyzer.evaluate(
                classification=move.classification,
                fen_before=move.fen_before,
                played_move_uci=move.uci,
                side_to_move=move.side_to_move,
                stockfish_eval_before=position_analysis.evaluation,
                stockfish_eval_after=played_eval_after,
                config=config.brilliant,
            )
            if brilliant_result is not None and brilliant_result.is_brilliant:
                move.classification = MoveClassification.BRILLIANT
                comment = (
                    "{0} (brilliant: only {1:.0%} of humans find it, Maia glance "
                    "{2:.2f} vs truth {3:.2f}, reveal {4:+.2f})".format(
                        comment,
                        brilliant_result.human_probability,
                        brilliant_result.maia_glance_wc,
                        brilliant_result.sf_truth_wc,
                        brilliant_result.reveal_score,
                    )
                )

        move.comment = "{0}\n{1}".format(move.comment, comment) if move.comment else comment

        return move

    def _emit_analyzing_progress(
        self,
        progress_callback: Optional[ProgressCallback],
        token: CancellationToken,
        game_id: str,
        move,
        total_plies: int,
    ) -> None:
        self._emit_progress(
            progress_callback,
            token,
            AnalysisProgress(
                game_id=game_id,
                phase="analyzing",
                current_ply=move.ply,
                total_plies=total_plies,
                san=move.san,
                message="analyzing {0}".format(move.san),
            ),
        )

    def _emit_move_complete_progress(
        self,
        progress_callback: Optional[ProgressCallback],
        token: CancellationToken,
        game_id: str,
        move,
        total_plies: int,
        completed_plies: Optional[int] = None,
    ) -> None:
        self._emit_progress(
            progress_callback,
            token,
            AnalysisProgress(
                game_id=game_id,
                phase="move_complete",
                current_ply=completed_plies if completed_plies is not None else move.ply,
                total_plies=total_plies,
                san=move.san,
                classification=move.classification,
                message="classified {0} as {1}".format(move.san, move.classification.value),
            ),
        )

    def _create_worker_engine(self) -> EngineAdapter:
        if self.engine_factory is None:
            raise ValueError("No engine_factory configured.")
        return self.engine_factory()

    def _close_engine(self, engine: EngineAdapter) -> None:
        close = getattr(engine, "close", None)
        if callable(close):
            close()

    def _emit_progress(
        self,
        progress_callback: Optional[ProgressCallback],
        cancel_token: CancellationToken,
        progress: AnalysisProgress,
    ) -> None:
        cancel_token.raise_if_cancelled()
        if progress_callback is not None:
            progress_callback(progress)
        cancel_token.raise_if_cancelled()
