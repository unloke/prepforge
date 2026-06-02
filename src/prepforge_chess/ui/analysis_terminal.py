from __future__ import annotations

from typing import Dict, List

from prepforge_chess.services.analysis_report import AnalysisReport, EvalGraphPoint


class TerminalAnalysisRenderer:
    def render(self, report: AnalysisReport) -> str:
        lines = [
            "Analysis Report",
            "Engine: {0}".format(report.engine),
            "Depth: {0}".format(report.depth if report.depth is not None else "-"),
            "Summary: {0}".format(self._format_summary(report.summary)),
            "Eval: {0}".format(self._sparkline(report.eval_graph)),
            "Jump: {0}".format(self._format_jump_plies(report.jump_plies)),
            "",
            "Key Moments:",
        ]

        if report.critical_moments:
            for moment in report.critical_moments:
                lines.append(
                    "  {0:>2}. {1:<8} {2:<12} best={3:<5} eval={4} {5}".format(
                        moment.ply,
                        moment.san,
                        moment.classification.value,
                        moment.best_move_uci or "-",
                        moment.score_cp if moment.score_cp is not None else "-",
                        moment.comment or "",
                    ).rstrip()
                )
        else:
            lines.append("  none")

        return "\n".join(lines)

    def _format_summary(self, summary: Dict[str, int]) -> str:
        if not summary:
            return "-"
        return ", ".join("{0}={1}".format(key, summary[key]) for key in sorted(summary))

    def _format_jump_plies(self, jump_plies: List[int]) -> str:
        if not jump_plies:
            return "-"
        return " ".join(str(ply) for ply in jump_plies)

    def _sparkline(self, points: List[EvalGraphPoint]) -> str:
        if not points:
            return "-"

        buckets = "._-=+*#%"
        chars = []
        for point in points:
            value = point.bounded_score_cp
            normalized = (value + 1000) / 2000.0
            index = int(round(normalized * (len(buckets) - 1)))
            index = max(0, min(len(buckets) - 1, index))
            chars.append(buckets[index])
        return "".join(chars)
