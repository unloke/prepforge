from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Protocol, Tuple

from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    MaiaMovePrediction,
    MoveRecord,
    MoveSource,
    OpeningNode,
)


@dataclass(frozen=True)
class EngineCandidate:
    move_uci: str
    san: str
    fen_after: str
    evaluation: EngineEvaluation
    rank: int


DETAIL_MODES = ("simple", "balanced", "deep")
MAIA_RATING_MIN = 600
MAIA_RATING_MAX = 2600
MAIA_RATING_DEFAULT = 2200
PLY_DEPTH_DEFAULT = 8
MAINLINE_THRESHOLD = 0.10
BRANCH_THRESHOLD = 0.30


@dataclass(frozen=True)
class GenerateConfig:
    # Primary controls for the new generator.
    ply_depth: int = PLY_DEPTH_DEFAULT
    detail_mode: str = "balanced"
    maia_rating: int = MAIA_RATING_DEFAULT
    # Threshold knobs kept on the config for backward compatibility but the
    # generator hard-codes 10% / 30% per the spec.
    opponent_branch_threshold: float = MAINLINE_THRESHOLD
    sub_branch_threshold: float = BRANCH_THRESHOLD
    preserve_manual_prepared_moves: bool = True
    overwrite_existing_analysis: bool = False
    # Side the generator should treat as "ours". Defaults to the repertoire's
    # colour; override to explore/demo the opponent's best lines.
    own_color: Optional[Color] = None
    # Deprecated / unused — kept as kwargs so old callers don't break.
    depth_plies: Optional[int] = None
    max_new_nodes: Optional[int] = None
    own_side_candidate_count: int = 1
    opponent_mainline_source: str = "mixed"
    auto_add_to_training_queue: bool = False
    human_likely_only: bool = False
    engine_critical_only: bool = False
    tactical_warning_scan: bool = True

    @property
    def effective_ply_depth(self) -> int:
        """Use `ply_depth` first; honor legacy `depth_plies` when explicitly set."""
        if self.depth_plies is not None:
            return self.depth_plies
        return self.ply_depth


@dataclass
class GeneratedNodeChange:
    node_id: str
    move_uci: str
    action: str
    source: MoveSource
    metadata: Dict[str, str] = field(default_factory=dict)


@dataclass
class GenerationSummary:
    added_nodes: int = 0
    updated_nodes: int = 0
    high_probability_unprepared: int = 0
    engine_critical_positions: int = 0
    tactical_warnings: int = 0
    engine_disagreements: int = 0
    training_queue_additions: int = 0
    changes: List[GeneratedNodeChange] = field(default_factory=list)


class EngineAdapter(Protocol):
    def candidates(self, fen: str, count: int) -> List[EngineCandidate]:
        raise NotImplementedError


class MaiaAdapter(Protocol):
    def predictions(
        self,
        fen: str,
        *,
        rating: Optional[int] = None,
    ) -> List[MaiaMovePrediction]:
        raise NotImplementedError


class ChessCoreAdapter(Protocol):
    def side_to_move(self, fen: str) -> Color:
        raise NotImplementedError

    def apply_uci(self, fen: str, move_uci: str) -> MoveRecord:
        raise NotImplementedError


def child_by_uci(node: OpeningNode, move_uci: str) -> Optional[OpeningNode]:
    for child in node.children:
        if child.move and child.move.uci == move_uci:
            return child
    return None


def maia_threshold_for_depth(relative_ply: int, config: GenerateConfig) -> float:
    return config.opponent_branch_threshold if relative_ply <= 1 else config.sub_branch_threshold


def merge_existing_node(
    node: OpeningNode,
    *,
    evaluation: Optional[EngineEvaluation] = None,
    maia_probability: Optional[float] = None,
    source: Optional[MoveSource] = None,
    overwrite_existing_analysis: bool = False,
) -> bool:
    changed = False
    if evaluation is not None and (overwrite_existing_analysis or node.engine_evaluation is None):
        node.engine_evaluation = evaluation
        changed = True
    if maia_probability is not None and (
        overwrite_existing_analysis or node.maia_probability is None
    ):
        node.maia_probability = maia_probability
        changed = True
    if source is not None and node.source not in {MoveSource.MANUAL, MoveSource.IMPORTED_PGN}:
        node.source = source
        changed = True
    return changed


def candidate_moves_for_node(
    *,
    node: OpeningNode,
    repertoire_color: Color,
    relative_ply: int,
    config: GenerateConfig,
    engine: EngineAdapter,
    maia: MaiaAdapter,
) -> Iterable[Tuple[str, MoveSource, Optional[EngineEvaluation], Optional[float]]]:
    if node.side_to_move is repertoire_color:
        if node.is_user_prepared_move and config.preserve_manual_prepared_moves:
            return []
        for candidate in engine.candidates(node.fen, config.own_side_candidate_count):
            yield candidate.move_uci, MoveSource.GENERATED_STOCKFISH, candidate.evaluation, None
        return

    threshold = maia_threshold_for_depth(relative_ply, config)
    emitted = set()

    if config.opponent_mainline_source in {"stockfish", "mixed"}:
        for candidate in engine.candidates(node.fen, 1):
            emitted.add(candidate.move_uci)
            yield candidate.move_uci, MoveSource.GENERATED_STOCKFISH, candidate.evaluation, None

    for prediction in sorted(maia.predictions(node.fen), key=lambda item: item.probability, reverse=True):
        if prediction.probability < threshold:
            continue
        if prediction.move_uci in emitted:
            yield prediction.move_uci, MoveSource.GENERATED_MAIA3, None, prediction.probability
        else:
            emitted.add(prediction.move_uci)
            yield prediction.move_uci, MoveSource.GENERATED_MAIA3, None, prediction.probability


def generate_from_position(
    *,
    root: OpeningNode,
    repertoire_color: Color,
    config: GenerateConfig,
    engine: EngineAdapter,
    maia: MaiaAdapter,
    chess_core: ChessCoreAdapter,
) -> GenerationSummary:
    """Generate an opening subtree from any existing node.

    This function is intentionally non-destructive: duplicate moves are merged,
    manual comments are not touched, and user-prepared moves are preserved.
    Creating concrete `MoveRecord` and `OpeningNode` instances is delegated to
    the caller because persistence owns stable ids.
    """

    summary = GenerationSummary()
    queue: List[Tuple[OpeningNode, int]] = [(root, 0)]

    while queue and summary.added_nodes < config.max_new_nodes:
        node, relative_ply = queue.pop(0)
        if relative_ply >= config.depth_plies:
            continue

        for move_uci, source, evaluation, probability in candidate_moves_for_node(
            node=node,
            repertoire_color=repertoire_color,
            relative_ply=relative_ply,
            config=config,
            engine=engine,
            maia=maia,
        ):
            existing = child_by_uci(node, move_uci)
            if existing is not None:
                changed = merge_existing_node(
                    existing,
                    evaluation=evaluation,
                    maia_probability=probability,
                    source=source,
                    overwrite_existing_analysis=config.overwrite_existing_analysis,
                )
                if changed:
                    summary.updated_nodes += 1
                    summary.changes.append(
                        GeneratedNodeChange(existing.id, move_uci, "updated", source)
                    )
                queue.append((existing, relative_ply + 1))
                continue

            # Persistence/UI layer creates the node, then calls this function again
            # or injects the child before continuing. The summary still records the
            # planned action so the caller can keep an undo log.
            summary.added_nodes += 1
            summary.changes.append(GeneratedNodeChange("", move_uci, "planned_add", source))

            if probability is not None and probability >= config.opponent_branch_threshold:
                summary.high_probability_unprepared += 1

            if summary.added_nodes >= config.max_new_nodes:
                break

    return summary
