from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from prepforge_chess.core.models import AnalysisResult, MoveClassification, MoveRecord


GRAPH_CP_LIMIT = 1000


@dataclass(frozen=True)
class EvalGraphPoint:
    ply: int
    san: str
    score_cp: Optional[int]
    mate_in: Optional[int]
    bounded_score_cp: int
    classification: MoveClassification


@dataclass(frozen=True)
class CriticalMoment:
    ply: int
    san: str
    played_uci: str
    classification: MoveClassification
    best_move_uci: Optional[str]
    score_cp: Optional[int]
    comment: Optional[str]


@dataclass(frozen=True)
class AnalysisReport:
    game_id: str
    engine: str
    depth: Optional[int]
    summary: Dict[str, int]
    eval_graph: List[EvalGraphPoint] = field(default_factory=list)
    critical_moments: List[CriticalMoment] = field(default_factory=list)
    jump_plies: List[int] = field(default_factory=list)


class AnalysisReportBuilder:
    def build(self, result: AnalysisResult) -> AnalysisReport:
        eval_graph = [self._graph_point(move) for move in result.move_results]
        critical_moments = [
            self._critical_moment(move)
            for move in result.move_results
            if self._is_report_critical(move)
        ]

        return AnalysisReport(
            game_id=result.game_id,
            engine=result.engine,
            depth=result.depth,
            summary=result.summary,
            eval_graph=eval_graph,
            critical_moments=critical_moments,
            jump_plies=[moment.ply for moment in critical_moments],
        )

    def _graph_point(self, move: MoveRecord) -> EvalGraphPoint:
        evaluation = move.engine_eval_after
        score_cp = evaluation.score_cp if evaluation is not None else None
        mate_in = evaluation.mate_in if evaluation is not None else None
        return EvalGraphPoint(
            ply=move.ply,
            san=move.san,
            score_cp=score_cp,
            mate_in=mate_in,
            bounded_score_cp=self._bounded_cp(score_cp, mate_in),
            classification=move.classification,
        )

    def _critical_moment(self, move: MoveRecord) -> CriticalMoment:
        evaluation = move.engine_eval_after
        return CriticalMoment(
            ply=move.ply,
            san=move.san,
            played_uci=move.uci,
            classification=move.classification,
            best_move_uci=move.best_move_uci,
            score_cp=evaluation.score_cp if evaluation is not None else None,
            comment=move.comment,
        )

    def _is_report_critical(self, move: MoveRecord) -> bool:
        return move.classification in {
            MoveClassification.BRILLIANT,
            MoveClassification.INACCURACY,
            MoveClassification.MISTAKE,
            MoveClassification.BLUNDER,
            MoveClassification.MISSED_WIN,
            MoveClassification.MISSED_TACTIC,
        }

    def _bounded_cp(self, score_cp: Optional[int], mate_in: Optional[int]) -> int:
        if mate_in is not None:
            if mate_in > 0:
                return GRAPH_CP_LIMIT
            if mate_in < 0:
                return -GRAPH_CP_LIMIT
            return 0
        if score_cp is None:
            return 0
        return max(-GRAPH_CP_LIMIT, min(GRAPH_CP_LIMIT, score_cp))
