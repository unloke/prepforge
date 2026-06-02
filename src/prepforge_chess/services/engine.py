from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Protocol

import chess
import chess.engine

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import EngineEvaluation


@dataclass(frozen=True)
class EngineAnalysisConfig:
    depth: Optional[int] = 10
    nodes: Optional[int] = None
    time_ms: Optional[int] = None
    multipv: int = 1


@dataclass(frozen=True)
class EngineCandidate:
    move_uci: str
    evaluation_after: EngineEvaluation
    rank: int
    pv: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class PositionAnalysis:
    fen: str
    evaluation: EngineEvaluation
    candidates: List[EngineCandidate] = field(default_factory=list)

    @property
    def best_move_uci(self) -> Optional[str]:
        return self.candidates[0].move_uci if self.candidates else None

    @property
    def best_evaluation_after(self) -> Optional[EngineEvaluation]:
        return self.candidates[0].evaluation_after if self.candidates else None


class EngineAdapter(Protocol):
    name: str

    def analyze_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> PositionAnalysis:
        raise NotImplementedError

    def evaluate_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> EngineEvaluation:
        raise NotImplementedError


class MockEngine:
    """Deterministic local engine for pipeline development and tests.

    It is not chess strength. It gives stable material-based evaluations and a
    legal best move so the analysis pipeline can be exercised before a real UCI
    engine binary is configured.
    """

    name = "mockfish"

    def __init__(self, chess_core: Optional[ChessCore] = None):
        self.chess_core = chess_core or ChessCore()

    def analyze_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> PositionAnalysis:
        board = self.chess_core.board(fen)
        evaluation = self.evaluate_position(fen, config)

        candidates: List[EngineCandidate] = []
        for move in board.legal_moves:
            after_board = board.copy(stack=False)
            after_board.push(move)
            evaluation_after = self._evaluation_for_board(
                after_board,
                config=config,
                best_move_uci=move.uci(),
                pv=[move.uci()],
            )
            candidates.append(
                EngineCandidate(
                    move_uci=move.uci(),
                    evaluation_after=evaluation_after,
                    rank=0,
                    pv=[move.uci()],
                )
            )

        reverse = board.turn == chess.WHITE
        candidates.sort(key=lambda item: item.evaluation_after.score_cp or 0, reverse=reverse)
        ranked = [
            EngineCandidate(
                move_uci=candidate.move_uci,
                evaluation_after=candidate.evaluation_after,
                rank=index,
                pv=candidate.pv,
            )
            for index, candidate in enumerate(candidates[: max(1, config.multipv)], start=1)
        ]

        return PositionAnalysis(fen=fen, evaluation=evaluation, candidates=ranked)

    def evaluate_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> EngineEvaluation:
        return self._evaluation_for_board(self.chess_core.board(fen), config=config)

    def _evaluation_for_board(
        self,
        board,
        *,
        config: EngineAnalysisConfig,
        best_move_uci: Optional[str] = None,
        pv: Optional[List[str]] = None,
    ) -> EngineEvaluation:
        score_cp = self._score_board_cp(board)
        return EngineEvaluation(
            engine=self.name,
            depth=config.depth,
            nodes=config.nodes,
            time_ms=config.time_ms,
            score_cp=score_cp,
            best_move_uci=best_move_uci,
            pv=pv or [],
        )

    def _score_board_cp(self, board) -> int:
        if board.is_checkmate():
            return -100000 if board.turn == chess.WHITE else 100000
        if board.is_stalemate() or board.is_insufficient_material():
            return 0

        piece_values = {
            1: 100,
            2: 320,
            3: 330,
            4: 500,
            5: 900,
            6: 0,
        }
        score = 0
        for piece in board.piece_map().values():
            value = piece_values[piece.piece_type]
            score += value if piece.color == chess.WHITE else -value

        mobility = board.legal_moves.count()
        score += mobility if board.turn == chess.WHITE else -mobility
        return score


class UciEngine:
    """Generic UCI adapter backed by `python-chess` SimpleEngine."""

    name = "uci"

    def __init__(
        self,
        executable_path: str,
        *,
        name: Optional[str] = None,
        chess_core: Optional[ChessCore] = None,
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
        options: Optional[Dict[str, object]] = None,
    ):
        self.executable_path = executable_path
        if name is not None:
            self.name = name
        self.chess_core = chess_core or ChessCore()
        self.threads = threads
        self.hash_mb = hash_mb
        self.options = dict(options or {})
        self._engine: Optional[chess.engine.SimpleEngine] = None

    def __enter__(self) -> "UciEngine":
        self._ensure_engine()
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()

    def analyze_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> PositionAnalysis:
        board = self.chess_core.board(fen)
        engine = self._ensure_engine()
        limit = self._limit(config)
        multipv = max(1, config.multipv)
        raw_info = engine.analyse(board, limit, multipv=multipv)
        info_items = raw_info if isinstance(raw_info, list) else [raw_info]

        candidates: List[EngineCandidate] = []
        for rank, info in enumerate(info_items, start=1):
            evaluation = self._evaluation_from_info(info, config=config)
            pv = [move.uci() for move in info.get("pv", [])]
            move_uci = pv[0] if pv else None
            if not move_uci:
                continue
            candidates.append(
                EngineCandidate(
                    move_uci=move_uci,
                    evaluation_after=evaluation,
                    rank=rank,
                    pv=pv,
                )
            )

        evaluation = self._evaluation_from_info(info_items[0], config=config) if info_items else (
            self.evaluate_position(fen, config)
        )
        return PositionAnalysis(fen=fen, evaluation=evaluation, candidates=candidates)

    def evaluate_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> EngineEvaluation:
        board = self.chess_core.board(fen)
        engine = self._ensure_engine()
        info = engine.analyse(board, self._limit(config))
        return self._evaluation_from_info(info, config=config)

    def close(self) -> None:
        if self._engine is not None:
            self._engine.quit()
            self._engine = None

    def _ensure_engine(self) -> chess.engine.SimpleEngine:
        if self._engine is None:
            self._engine = chess.engine.SimpleEngine.popen_uci(self.executable_path)
            options = dict(self.options)
            if self.threads is not None:
                options["Threads"] = self.threads
            if self.hash_mb is not None:
                options["Hash"] = self.hash_mb
            if options:
                self._engine.configure(options)
        return self._engine

    def _limit(self, config: EngineAnalysisConfig) -> chess.engine.Limit:
        return chess.engine.Limit(
            depth=config.depth,
            nodes=config.nodes,
            time=(config.time_ms / 1000.0) if config.time_ms is not None else None,
        )

    def _evaluation_from_info(
        self,
        info,
        *,
        config: EngineAnalysisConfig,
    ) -> EngineEvaluation:
        pov_score = info.get("score")
        score_cp = None
        mate_in = None
        if pov_score is not None:
            white_score = pov_score.white()
            mate_in = white_score.mate()
            score_cp = white_score.score(mate_score=100000)

        pv = [move.uci() for move in info.get("pv", [])]
        wdl = self._wdl_from_info(info)
        return EngineEvaluation(
            engine=self.name,
            depth=info.get("depth", config.depth),
            nodes=info.get("nodes", config.nodes),
            time_ms=config.time_ms,
            score_cp=score_cp,
            mate_in=mate_in,
            best_move_uci=pv[0] if pv else None,
            pv=pv,
            wdl=wdl,
        )

    def _wdl_from_info(self, info) -> Optional[Dict[str, float]]:
        raw = info.get("wdl")
        if raw is None:
            return None

        try:
            white = raw.white()
        except AttributeError:
            white = raw

        wins = getattr(white, "wins", None)
        draws = getattr(white, "draws", None)
        losses = getattr(white, "losses", None)
        if wins is None or draws is None or losses is None:
            return None

        total = float(wins + draws + losses)
        if total <= 0:
            return None

        return {
            "white_win": float(wins) / total,
            "white_draw": float(draws) / total,
            "white_loss": float(losses) / total,
        }


class StockfishEngine(UciEngine):
    """Stockfish UCI adapter."""

    name = "stockfish"
