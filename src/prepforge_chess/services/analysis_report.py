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
class AnalysisReport:
    game_id: str
    engine: str
    depth: Optional[int]
    summary: Dict[str, int]
    eval_graph: List[EvalGraphPoint] = field(default_factory=list)


class AnalysisReportBuilder:
    def build(self, result: AnalysisResult) -> AnalysisReport:
        return AnalysisReport(
            game_id=result.game_id,
            engine=result.engine,
            depth=result.depth,
            summary=result.summary,
            eval_graph=[self._graph_point(move) for move in result.move_results],
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
