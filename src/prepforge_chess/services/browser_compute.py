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

import math
import re
from collections import Counter
from copy import deepcopy
from typing import Any, Dict, List, Optional

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
from prepforge_chess.services.replay_engine import (
    ReplayEngine,
    client_search_depth,
    client_search_nodes,
)


from prepforge_chess.services.analysis_metadata import (
    build_analysis_quality,
    generated_analysis_metadata,
)

# Bounded shapes for the untrusted per-position payload (D-03).
_UCI_RE = re.compile(r"^[a-h][1-8][a-h][1-8][qrbn]?$")
_MAX_PV_LEN = 64
_MAX_MATE_IN = 200
_MAX_DEPTH = 64
_MAX_NODES = 10**12
_MAX_SCORE_CP = 10**7


class PositionPayloadError(ValueError):
    """A malformed position payload item. Carries a field-level message; routes
    translate it to a 400 so a bad client payload is a readable 4xx, never a
    500 and never a partial write."""


def _validate_int(
    value: Any, field: str, *, lo: int, hi: int, required: bool = False
) -> Optional[int]:
    if value is None:
        if required:
            raise PositionPayloadError("{0} is required".format(field))
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PositionPayloadError("{0} must be a number".format(field))
    if not math.isfinite(value) or int(value) != value:
        raise PositionPayloadError("{0} must be a whole number".format(field))
    value = int(value)
    if value < lo or value > hi:
        raise PositionPayloadError(
            "{0} must be between {1} and {2}".format(field, lo, hi)
        )
    return value


def _validate_uci(value: Any, field: str) -> Optional[str]:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not _UCI_RE.match(value):
        raise PositionPayloadError("{0} must be a UCI move".format(field))
    return value


def validate_position_item(item: Any, index: int) -> Dict[str, Any]:
    """Validate one untrusted position payload item (D-03).

    Raises :class:`PositionPayloadError` with a field-level message on anything
    the classifier cannot safely coerce — non-numeric scores, out-of-range
    depths/nodes/mate distances, malformed PVs. Returns the item unchanged so
    the caller can keep the existing lookup keys.
    """
    field = "positions[{0}]".format(index)
    if not isinstance(item, dict):
        raise PositionPayloadError("{0} must be an object".format(field))
    fen = item.get("fen")
    if not fen or not isinstance(fen, str):
        raise PositionPayloadError("{0}.fen must be a non-empty string".format(field))
    score_cp = item.get("score_cp")
    if score_cp is not None:
        _validate_int(score_cp, "{0}.score_cp".format(field), lo=-_MAX_SCORE_CP, hi=_MAX_SCORE_CP)
    mate_in = item.get("mate_in")
    if mate_in is not None:
        _validate_int(mate_in, "{0}.mate_in".format(field), lo=-_MAX_MATE_IN, hi=_MAX_MATE_IN)
    # depth 0 is legitimate: a terminal position needs no search.
    _validate_int(item.get("depth"), "{0}.depth".format(field), lo=0, hi=_MAX_DEPTH)
    _validate_int(item.get("nodes"), "{0}.nodes".format(field), lo=0, hi=_MAX_NODES)
    _validate_int(item.get("time_ms"), "{0}.time_ms".format(field), lo=0, hi=10**10)
    _validate_uci(item.get("best_move_uci"), "{0}.best_move_uci".format(field))
    pv = item.get("pv")
    if pv is not None:
        if not isinstance(pv, list):
            raise PositionPayloadError("{0}.pv must be a list of UCI moves".format(field))
        if len(pv) > _MAX_PV_LEN:
            raise PositionPayloadError(
                "{0}.pv must have at most {1} moves".format(field, _MAX_PV_LEN)
            )
        for i, ply in enumerate(pv):
            _validate_uci(ply, "{0}.pv[{1}]".format(field, i))
    return item


def validate_position_payload(positions: Any) -> List[Dict[str, Any]]:
    """Validate the whole ``positions`` list; returns the items unchanged."""
    if not isinstance(positions, list):
        raise PositionPayloadError("positions must be a list")
    return [validate_position_item(item, i) for i, item in enumerate(positions)]


def _evaluation_from_client(
    data: Dict[str, Any], *, engine_name: str, depth: int
) -> EngineEvaluation:
    score_cp = data.get("score_cp")
    mate_in = data.get("mate_in")
    try:
        score_cp = int(score_cp) if score_cp is not None else None
        mate_in = int(mate_in) if mate_in is not None else None
    except (TypeError, ValueError) as exc:
        # validate_position_payload should have caught this; keep the same
        # readable-4xx semantics as a last line of defence (never a 500).
        raise PositionPayloadError("score_cp/mate_in must be numbers") from exc
    return EngineEvaluation(
        engine=engine_name,
        # The actual depth the browser search reached (0 = terminal position,
        # no search); `depth` is only the requested fallback for legacy
        # payloads, so a shallow timed-out result is never mislabelled.
        depth=client_search_depth(data, depth),
        nodes=client_search_nodes(data),
        score_cp=score_cp,
        mate_in=mate_in,
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
    maia_available: Optional[bool] = None,
    maia_rating: Optional[int] = None,
) -> AnalysisResult:
    """Apply client evals, classify each move exactly once, build the result.

    ``position_map`` maps FEN → ``{score_cp, mate_in, best_move_uci, pv, depth}``
    as produced by the browser Stockfish provider (``depth`` = actual search
    depth reached). A missing FEN raises the same
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
        key = normalized[fen]
        data = {name: value for name, value in data.items() if name != "fen"}
        existing = by_normalized.get(key)
        if existing is not None and existing != data:
            # Two spellings of one position carrying DIFFERENT evals: the
            # result would depend on dict order (D-03 "duplicate conflicts").
            raise PositionPayloadError(
                "conflicting evaluations for the same position: {0}".format(fen)
            )
        by_normalized.setdefault(key, data)

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
        # A-04: the explanation is GENERATED content owned by this run. It is
        # stored apart from the original/user comment and REPLACED (never
        # appended) on re-analysis, so re-running can't accumulate duplicates.
        # The meta records who wrote it (versioned), so the generated block is
        # identifiable without text matching.
        move.generated_comment = comment
        move.generated_meta = generated_analysis_metadata(engine_name, depth)

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
        quality=build_analysis_quality(
            game,
            target_depth=depth,
            engine_name=engine_name,
            maia_available=(
                brilliant_analyzer is not None if maia_available is None else maia_available
            ),
            maia_rating=maia_rating,
        ),
    )


