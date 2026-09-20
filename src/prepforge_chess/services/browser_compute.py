"""Browser-compute fast path for Analyze classify-save.

The browser already ran Stockfish (per-position evals: score, mate, best move,
PV) and optionally Maia3 (move assessments for Brilliant detection). The
server's remaining work is pure application of those precomputed numbers:

    validate payload → apply precomputed evals to moves → classify moves
    → build summary → persist efficiently → return payload

``classify_move`` and ``BrilliantAnalyzer`` stay the single source of truth —
this helper calls the same functions as the engine-driven ``AnalysisService``
path, so classifications, comments, summaries, and critical plies are
identical. What it skips is the engine-oriented orchestration (ReplayEngine
lookups per position, per-move cache plumbing, progress emission) that only
exists to *obtain* evals the browser already supplied.

Persistence goes through ``repository.save_game_batched`` (bulk
position/eval/move writes in one transaction) instead of the legacy
per-move ``save_game`` loop, so SQL round-trips stay near-constant in game
length on both SQLite and PostgreSQL.
"""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
from typing import Any, Dict, Optional

from prepforge_chess.core.models import (
    AnalysisResult,
    EngineEvaluation,
    Game,
    MoveClassification,
    utc_now,
)
from prepforge_chess.services.brilliant import (
    BRILLIANT_ELIGIBLE_CLASSIFICATIONS,
    BrilliantAnalyzer,
    BrilliantConfig,
)
from prepforge_chess.services.classification import classify_move
from prepforge_chess.services.replay_engine import ReplayEngine


def _evaluation_from_client(
    data: Dict[str, Any], *, engine_name: str, depth: int
) -> EngineEvaluation:
    score_cp = data.get("score_cp")
    mate_in = data.get("mate_in")
    return EngineEvaluation(
        engine=engine_name,
        depth=depth,
        score_cp=int(score_cp) if score_cp is not None else None,
        mate_in=int(mate_in) if mate_in is not None else None,
        best_move_uci=data.get("best_move_uci") or None,
        pv=list(data.get("pv") or []),
    )


def _apply_brilliant(
    move,
    analyzer: Optional[BrilliantAnalyzer],
    *,
    eval_before: EngineEvaluation,
    eval_after: EngineEvaluation,
    comment: str,
    config: Optional[BrilliantConfig] = None,
):
    if (
        analyzer is None
        or move.classification not in BRILLIANT_ELIGIBLE_CLASSIFICATIONS
    ):
        return comment
    brilliant_result = analyzer.evaluate(
        classification=move.classification,
        fen_before=move.fen_before,
        played_move_uci=move.uci,
        side_to_move=move.side_to_move,
        stockfish_eval_before=eval_before,
        stockfish_eval_after=eval_after,
        config=config,
    )
    if brilliant_result is not None and brilliant_result.is_brilliant:
        move.classification = MoveClassification.BRILLIANT
        trap = brilliant_result.trap_gap
        comment = (
            "{0} (brilliant: only {1:.0%} of humans find it, Maia glance "
            "{2:.2f} vs truth {3:.2f}, reveal {4:+.2f}, trap {5})".format(
                comment,
                brilliant_result.human_probability,
                brilliant_result.maia_glance_wc,
                brilliant_result.sf_truth_wc,
                brilliant_result.reveal_score,
                "{0:+.2f}".format(trap) if trap is not None else "n/a",
            )
        )
    return comment


def classify_precomputed_game(
    game: Game,
    position_map: Dict[str, Dict[str, Any]],
    *,
    engine_name: str,
    depth: int,
    brilliant_analyzer: Optional[BrilliantAnalyzer] = None,
    brilliant_config: Optional[BrilliantConfig] = None,
) -> AnalysisResult:
    """Apply client evals, classify each move exactly once, build the result.

    ``position_map`` maps FEN → ``{score_cp, mate_in, best_move_uci, pv}`` as
    produced by the browser Stockfish provider. A missing FEN raises the same
    ``ReplayEngineError`` the legacy path raises (incomplete browser payload →
    400), so error semantics are unchanged. ``game.moves`` is classified
    in place (same as ``AnalysisService``) and also returned via the result.

    FEN normalization (python-chess Board construction) happens once per
    distinct position up front — the legacy path re-normalizes the same FEN
    on every move's before/after lookup.
    """
    replay = ReplayEngine(position_map, name=engine_name)
    normalized: Dict[str, str] = {}
    for fen in position_map:
        try:
            normalized[fen] = replay._key(fen)
        except Exception:  # noqa: BLE001 - fall back to the raw key
            normalized[fen] = fen
    by_normalized: Dict[str, Dict[str, Any]] = {}
    for fen, data in position_map.items():
        by_normalized.setdefault(normalized[fen], data)

    def _lookup(fen: str) -> Dict[str, Any]:
        data = by_normalized.get(normalized.get(fen, fen))
        if data is None:
            from prepforge_chess.services.replay_engine import ReplayEngineError

            raise ReplayEngineError("no client evaluation for position: {0}".format(fen))
        return data

    for move in game.moves:
        before = _lookup(move.fen_before)
        after = _lookup(move.fen_after)
        eval_before = _evaluation_from_client(before, engine_name=engine_name, depth=depth)
        # At multipv 1 the position eval under best play equals the eval after
        # the best move (negamax) — the same identity ReplayEngine encodes, so
        # best_move_eval reuses eval_before instead of a second lookup.
        eval_after = _evaluation_from_client(after, engine_name=engine_name, depth=depth)
        best_move_uci = before.get("best_move_uci") or None
        best_eval_after = eval_before

        move.engine_eval_before = deepcopy(eval_before)
        move.engine_eval_after = deepcopy(eval_after)
        move.best_move_uci = best_move_uci
        move.best_move_eval = deepcopy(best_eval_after)

        classification = classify_move(
            side_to_move=move.side_to_move,
            played_move_uci=move.uci,
            best_move_uci=move.best_move_uci,
            played_eval_after=eval_after,
            best_eval_after=best_eval_after,
        )
        move.classification = classification.classification
        comment = classification.reason
        comment = _apply_brilliant(
            move,
            brilliant_analyzer,
            eval_before=eval_before,
            eval_after=eval_after,
            comment=comment,
            config=brilliant_config,
        )
        move.comment = "{0}\n{1}".format(move.comment, comment) if move.comment else comment

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
    return AnalysisResult(
        game_id=game.id,
        analyzed_at=utc_now(),
        engine=engine_name,
        depth=depth,
        move_results=game.moves,
        summary=dict(summary),
        critical_ply=critical,
    )
