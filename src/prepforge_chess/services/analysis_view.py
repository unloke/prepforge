"""Analysis serialization — a pure view over an :class:`AnalysisResult`.

Turns a completed analysis (classified moves + summary) into the JSON payload the
SPA's Analyze view consumes. It computes **no chess**: classification/eval already
happened (server-side ReplayEngine over browser-supplied evals), so this only walks
the result and the derived report. Shared by the new FastAPI analyze endpoints and
the legacy ``web/server.py`` so the two serializations cannot diverge during the
strangler migration (the legacy ``_analysis_payload`` is frozen and deleted with the
old server).
"""
from __future__ import annotations

from typing import Any, Dict

from prepforge_chess.core.models import AnalysisResult
from prepforge_chess.services.analysis_report import AnalysisReportBuilder


def analysis_result_to_payload(result: AnalysisResult) -> Dict[str, Any]:
    """Serialize a classified game: per-move classifications, the eval graph, and
    the critical moments the Analyze view highlights."""
    report = AnalysisReportBuilder().build(result)
    return {
        "game_id": result.game_id,
        "engine": result.engine,
        "depth": result.depth,
        "summary": result.summary,
        "moves": [
            {
                "ply": move.ply,
                "move_number": move.move_number,
                "side": move.side_to_move.value,
                "san": move.san,
                "uci": move.uci,
                "fen_before": move.fen_before,
                "fen_after": move.fen_after,
                "classification": move.classification.value,
                "best_move_uci": move.best_move_uci,
                "score_cp": move.engine_eval_after.score_cp
                if move.engine_eval_after is not None
                else None,
                "comment": move.comment,
            }
            for move in result.move_results
        ],
        "eval_graph": [
            {
                "ply": point.ply,
                "san": point.san,
                "score_cp": point.score_cp,
                "bounded_score_cp": point.bounded_score_cp,
                "classification": point.classification.value,
            }
            for point in report.eval_graph
        ],
        "critical_moments": [
            {
                "ply": moment.ply,
                "san": moment.san,
                "classification": moment.classification.value,
                "best_move_uci": moment.best_move_uci,
                "score_cp": moment.score_cp,
                "comment": moment.comment,
            }
            for moment in report.critical_moments
        ],
    }
