"""Pure output metadata shared by engine-driven and browser-compute analysis."""
from typing import Any, Dict, List, Optional

from prepforge_chess.core.models import Game, utc_now

EXPLANATION_ALGORITHM_VERSION = "explain-v1"
CLASSIFICATION_ALGORITHM_VERSION = "classify-v1"


def generated_analysis_metadata(engine_name: str, depth: Optional[int]) -> Dict[str, Any]:
    return {
        "algorithm_version": EXPLANATION_ALGORITHM_VERSION,
        "classification_version": CLASSIFICATION_ALGORITHM_VERSION,
        "engine": engine_name,
        "depth": depth,
        "analyzed_at": utc_now().isoformat(),
    }


def build_analysis_quality(
    game: Game,
    *,
    target_depth: Optional[int],
    engine_name: str,
    maia_available: bool,
    maia_rating: Optional[int],
) -> Dict[str, Any]:
    """A-05: search/model quality of this run, so the report can say what was
    actually analysed instead of implying uniform full-depth coverage.

    "depth" per move is the ACTUAL search depth the browser reached (0 =
    terminal); anything below the requested target is "shallow" and counted."""
    actual_depths: List[int] = []
    for move in game.moves:
        for evaluation in (move.engine_eval_before, move.engine_eval_after):
            if evaluation is not None and evaluation.depth is not None:
                actual_depths.append(int(evaluation.depth))
    shallow = sum(1 for d in actual_depths if target_depth is not None and 0 < d < target_depth)
    terminal = sum(1 for d in actual_depths if d == 0)
    search = "full" if actual_depths and shallow == 0 else (
        "partial-shallow" if actual_depths else "none"
    )
    issues: List[str] = []
    if shallow:
        issues.append("partial-shallow")
    if not maia_available:
        issues.append("no-maia")
    return {
        "target_depth": target_depth,
        "actual_depth_min": min(actual_depths) if actual_depths else None,
        "actual_depth_max": max(actual_depths) if actual_depths else None,
        "actual_depth_avg": (
            round(sum(actual_depths) / len(actual_depths), 1) if actual_depths else None
        ),
        "shallow_positions": shallow,
        "terminal_positions": terminal,
        "search": search,
        "maia": {
            "available": bool(maia_available),
            "model": "maia3" if maia_available else None,
            "rating": maia_rating,
        },
        # "complete" only when every position met the target depth AND the
        # human model ran; otherwise the labelled issues list what is missing.
        "completeness": "complete" if not issues else ",".join(issues),
        "engine": engine_name,
        "classification_version": CLASSIFICATION_ALGORITHM_VERSION,
        "explanation_version": EXPLANATION_ALGORITHM_VERSION,
    }
