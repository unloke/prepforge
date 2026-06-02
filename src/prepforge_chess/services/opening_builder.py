from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Set, Tuple

from prepforge_chess.core.chess_core import STARTING_FEN, ChessCore
from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    MoveRecord,
    MoveSource,
    OpeningNode,
    Repertoire,
)
from prepforge_chess.services.engine import EngineAdapter, EngineAnalysisConfig, MockEngine
from prepforge_chess.services.maia import MaiaAdapter
from prepforge_chess.services.opening_generation import (
    BRANCH_THRESHOLD,
    GenerateConfig,
    GeneratedNodeChange,
    GenerationSummary,
    MAINLINE_THRESHOLD,
    child_by_uci,
    maia_threshold_for_depth,
    merge_existing_node,
)
from prepforge_chess.storage.repositories import PrepForgeRepository


@dataclass(frozen=True)
class CreateRepertoireRequest:
    name: str
    color: Color
    root_fen: str = STARTING_FEN
    notes: Optional[str] = None
    tags: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class EngineMoveCandidate:
    move_uci: str
    evaluation: EngineEvaluation
    rank: int


@dataclass(frozen=True)
class OpeningTreeItem:
    node_id: str
    parent_id: Optional[str]
    depth: int
    san: str
    uci: Optional[str]
    source: MoveSource
    is_mainline: bool
    is_prepared: bool
    is_enabled: bool
    maia_probability: Optional[float]
    tags: List[str]
    comment: Optional[str]


@dataclass(frozen=True)
class OpeningTreeReport:
    repertoire_id: str
    name: str
    color: Color
    total_nodes: int
    visible_nodes: List[OpeningTreeItem]


class OpeningBuilderService:
    def __init__(
        self,
        repository: PrepForgeRepository,
        chess_core: Optional[ChessCore] = None,
        engine: Optional[EngineAdapter] = None,
        engine_config: Optional[EngineAnalysisConfig] = None,
        maia: Optional[MaiaAdapter] = None,
    ):
        self.repository = repository
        self.chess_core = chess_core or ChessCore()
        self.engine = engine or MockEngine(self.chess_core)
        self.engine_config = engine_config or EngineAnalysisConfig(depth=8)
        if maia is None:
            # No silent fake: a stand-in for the human model has to be supplied
            # explicitly (real Maia3 in production, a deterministic stub in tests)
            # so a missing model surfaces loudly instead of producing fake data.
            raise ValueError(
                "OpeningBuilderService requires a Maia adapter. Pass "
                "create_maia3_adapter(...) in production, or an explicit stub in tests."
            )
        self.maia = maia

    def create_repertoire(self, request: CreateRepertoireRequest) -> Repertoire:
        repertoire_id = str(uuid.uuid4())
        root = OpeningNode(
            id=str(uuid.uuid4()),
            repertoire_id=repertoire_id,
            fen=self.chess_core.normalize_fen(request.root_fen),
            side_to_move=self.chess_core.side_to_move(request.root_fen),
            is_mainline=True,
            source=MoveSource.MANUAL,
        )
        repertoire = Repertoire(
            id=repertoire_id,
            name=request.name,
            color=request.color,
            root_fen=root.fen,
            root_node=root,
            main_engine=self.engine.name,
            human_model=self.maia.name,
            notes=request.notes,
            tags=list(request.tags),
        )
        self.repository.save_repertoire(repertoire)
        return repertoire

    def add_move(
        self,
        repertoire_id: str,
        parent_node_id: str,
        move_uci: str,
        *,
        source: MoveSource = MoveSource.MANUAL,
        is_mainline: bool = False,
        is_user_prepared_move: bool = False,
        comment: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> OpeningNode:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        parent = self._find_node_or_raise(repertoire.root_node, parent_node_id)
        existing = child_by_uci(parent, move_uci)
        if existing is not None:
            existing.is_mainline = existing.is_mainline or is_mainline
            existing.is_user_prepared_move = (
                existing.is_user_prepared_move or is_user_prepared_move
            )
            if comment and not existing.comment:
                existing.comment = comment
            for tag in tags or []:
                if tag not in existing.tags:
                    existing.tags.append(tag)
            self.repository.save_repertoire(repertoire)
            return existing

        move = self.chess_core.apply_uci(parent.fen, move_uci, source=source)
        child = OpeningNode(
            id=str(uuid.uuid4()),
            repertoire_id=repertoire.id,
            parent_id=parent.id,
            move=move,
            fen=move.fen_after,
            side_to_move=self.chess_core.side_to_move(move.fen_after),
            is_mainline=is_mainline,
            is_user_prepared_move=is_user_prepared_move,
            comment=comment,
            tags=tags or [],
            source=source,
        )
        parent.children.append(child)
        self.repository.save_repertoire(repertoire)
        return child

    def generate_from_node(
        self,
        repertoire_id: str,
        node_id: str,
        config: GenerateConfig,
        progress_callback: Optional[
            Callable[..., None]
        ] = None,
    ) -> Tuple[Repertoire, GenerationSummary]:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        root = self._find_node_or_raise(repertoire.root_node, node_id)
        summary = GenerationSummary()

        detail_mode = (config.detail_mode or "balanced").lower()
        if detail_mode not in {"simple", "balanced", "deep"}:
            raise ValueError("detail_mode must be one of simple, balanced, deep")
        ply_depth = max(1, int(config.effective_ply_depth))
        maia_rating = self._clamp_rating(config.maia_rating)

        # Rough pessimistic estimate used only as a starting hint for any
        # caller that wants to drive a progress bar; the caller can refine it.
        per_ply = {"simple": 3, "balanced": 8, "deep": 12}.get(detail_mode, 6)
        total_hint = max(8, ply_depth * per_ply)

        self._progress_callback = progress_callback
        self._progress_total_hint = total_hint
        if progress_callback is not None:
            progress_callback("started", added=0, total_hint=total_hint)

        try:
            self._expand(
                node=root,
                repertoire=repertoire,
                relative_ply=0,
                ply_depth=ply_depth,
                detail_mode=detail_mode,
                on_mainline_path=True,
                maia_rating=maia_rating,
                summary=summary,
                config=config,
            )

            self.repository.save_repertoire(repertoire)
            if progress_callback is not None:
                progress_callback(
                    "completed",
                    added=summary.added_nodes,
                    total_hint=max(summary.added_nodes, total_hint),
                )
        finally:
            self._progress_callback = None
            self._progress_total_hint = 0

        return repertoire, summary

    @staticmethod
    def _clamp_rating(rating: int) -> int:
        try:
            value = int(rating)
        except (TypeError, ValueError):
            value = 2200
        return max(600, min(2600, value))

    def _expand(
        self,
        *,
        node: OpeningNode,
        repertoire: Repertoire,
        relative_ply: int,
        ply_depth: int,
        detail_mode: str,
        on_mainline_path: bool,
        maia_rating: int,
        summary: GenerationSummary,
        config: GenerateConfig,
    ) -> None:
        if relative_ply >= ply_depth:
            return

        own_color = config.own_color or repertoire.color
        user_turn = node.side_to_move is own_color
        if user_turn:
            manual_prepared_moves = (
                self._manual_prepared_child_ucis(node)
                if config.preserve_manual_prepared_moves
                else set()
            )
            branch_limit = max(1, int(getattr(config, "own_side_candidate_count", 1) or 1))
            candidate_count = branch_limit + len(manual_prepared_moves)
            candidates = self._engine_candidates(node.fen, candidate_count)
            if not candidates:
                return
            generated_branches = 0
            for candidate in candidates:
                if candidate.move_uci in manual_prepared_moves:
                    continue
                child = self._upsert_child(
                    parent=node,
                    repertoire=repertoire,
                    move_uci=candidate.move_uci,
                    source=MoveSource.GENERATED_STOCKFISH,
                    evaluation=candidate.evaluation,
                    probability=None,
                    intended_mainline=not manual_prepared_moves,
                    summary=summary,
                )
                if child is None:
                    continue
                self._expand(
                    node=child,
                    repertoire=repertoire,
                    relative_ply=relative_ply + 1,
                    ply_depth=ply_depth,
                    detail_mode=detail_mode,
                    on_mainline_path=on_mainline_path and not manual_prepared_moves,
                    maia_rating=maia_rating,
                    summary=summary,
                    config=config,
                )
                generated_branches += 1
                if generated_branches >= branch_limit:
                    break
            return

        # Opponent's turn → Maia
        threshold = MAINLINE_THRESHOLD if on_mainline_path else BRANCH_THRESHOLD
        predictions = sorted(
            self.maia.predictions(node.fen, rating=maia_rating),
            key=lambda item: item.probability,
            reverse=True,
        )
        if not predictions:
            return
        kept = [p for p in predictions if p.probability >= threshold]
        if not kept:
            kept = [predictions[0]]

        mainline_pred = kept[0]
        branch_preds = kept[1:]

        main_child = self._upsert_child(
            parent=node,
            repertoire=repertoire,
            move_uci=mainline_pred.move_uci,
            source=MoveSource.GENERATED_MAIA3,
            evaluation=None,
            probability=mainline_pred.probability,
            intended_mainline=True,
            summary=summary,
        )
        if main_child is not None:
            self._expand(
                node=main_child,
                repertoire=repertoire,
                relative_ply=relative_ply + 1,
                ply_depth=ply_depth,
                detail_mode=detail_mode,
                on_mainline_path=on_mainline_path,
                maia_rating=maia_rating,
                summary=summary,
                config=config,
            )

        for branch_pred in branch_preds:
            branch_child = self._upsert_child(
                parent=node,
                repertoire=repertoire,
                move_uci=branch_pred.move_uci,
                source=MoveSource.GENERATED_MAIA3,
                evaluation=None,
                probability=branch_pred.probability,
                intended_mainline=False,
                summary=summary,
            )
            if branch_child is None:
                continue
            if detail_mode == "simple":
                # Create the branch node, but do not recurse into it.
                continue
            # balanced / deep: recurse, but now we are off the mainline path.
            self._expand(
                node=branch_child,
                repertoire=repertoire,
                relative_ply=relative_ply + 1,
                ply_depth=ply_depth,
                detail_mode=detail_mode,
                on_mainline_path=False,
                maia_rating=maia_rating,
                summary=summary,
                config=config,
            )

    def _upsert_child(
        self,
        *,
        parent: OpeningNode,
        repertoire: Repertoire,
        move_uci: str,
        source: MoveSource,
        evaluation,
        probability,
        intended_mainline: bool,
        summary: GenerationSummary,
    ) -> Optional[OpeningNode]:
        existing = child_by_uci(parent, move_uci)
        if existing is not None:
            # Update analysis fields without touching manual flags / comments / tags.
            changed = False
            if evaluation is not None and existing.engine_evaluation is None:
                existing.engine_evaluation = evaluation
                changed = True
            if probability is not None and existing.maia_probability is None:
                existing.maia_probability = probability
                changed = True
            # Only upgrade `source` if it's a generic/unknown one and the
            # existing node wasn't user-authored.
            if existing.source not in {MoveSource.MANUAL, MoveSource.IMPORTED_PGN}:
                if existing.source != source:
                    existing.source = source
                    changed = True
            if changed:
                summary.updated_nodes += 1
                summary.changes.append(
                    GeneratedNodeChange(existing.id, move_uci, "updated", source)
                )
            return existing

        # New child.
        move = self.chess_core.apply_uci(parent.fen, move_uci, source=source)
        is_mainline = bool(intended_mainline) and not any(
            child.is_mainline for child in parent.children
        )
        child = OpeningNode(
            id=str(uuid.uuid4()),
            repertoire_id=repertoire.id,
            parent_id=parent.id,
            move=move,
            fen=move.fen_after,
            side_to_move=self.chess_core.side_to_move(move.fen_after),
            engine_evaluation=evaluation,
            maia_probability=probability,
            is_mainline=is_mainline,
            is_user_prepared_move=parent.side_to_move is repertoire.color,
            source=source,
        )
        parent.children.append(child)
        summary.added_nodes += 1
        summary.changes.append(
            GeneratedNodeChange(child.id, move_uci, "added", source)
        )
        if probability is not None and probability >= MAINLINE_THRESHOLD:
            summary.high_probability_unprepared += 1
        callback = getattr(self, "_progress_callback", None)
        if callback is not None:
            callback(
                "node_added",
                added=summary.added_nodes,
                total_hint=max(getattr(self, "_progress_total_hint", 0), summary.added_nodes),
            )
        return child

    def set_as_mainline(self, repertoire_id: str, node_id: str) -> OpeningNode:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        if node.parent_id is None:
            node.is_mainline = True
        else:
            parent = self._find_node_or_raise(repertoire.root_node, node.parent_id)
            for child in parent.children:
                child.is_mainline = child.id == node.id
            node.is_mainline = True
        self.repository.save_repertoire(repertoire)
        return node

    def mark_prepared(self, repertoire_id: str, node_id: str, prepared: bool = True) -> OpeningNode:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        node.is_user_prepared_move = prepared
        self.repository.save_repertoire(repertoire)
        return node

    def disable_branch(self, repertoire_id: str, node_id: str) -> OpeningNode:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        self._set_branch_enabled(node, False)
        self.repository.save_repertoire(repertoire)
        return node

    def enable_branch(self, repertoire_id: str, node_id: str) -> OpeningNode:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        self._set_branch_enabled(node, True)
        self.repository.save_repertoire(repertoire)
        return node

    def add_comment(self, repertoire_id: str, node_id: str, comment: str) -> OpeningNode:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        node.comment = comment
        self.repository.save_repertoire(repertoire)
        return node

    def add_tag(self, repertoire_id: str, node_id: str, tag: str) -> OpeningNode:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        if tag not in node.tags:
            node.tags.append(tag)
        self.repository.save_repertoire(repertoire)
        return node

    def set_annotations(
        self,
        repertoire_id: str,
        node_id: str,
        arrows: List[str],
        circles: List[str],
    ) -> OpeningNode:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        node.arrows = list(arrows or [])
        node.circles = list(circles or [])
        self.repository.save_repertoire(repertoire)
        return node

    def delete_node(self, repertoire_id: str, node_id: str) -> Optional[str]:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        if node.parent_id is None:
            raise ValueError("cannot delete the root position")
        parent = self._find_node_or_raise(repertoire.root_node, node.parent_id)
        removed_ids: List[str] = []

        def collect(target: OpeningNode) -> None:
            removed_ids.append(target.id)
            for child in target.children:
                collect(child)

        collect(node)
        parent.children = [child for child in parent.children if child.id != node_id]
        self.repository.save_repertoire(repertoire)
        self.repository.delete_opening_nodes(repertoire_id, removed_ids)
        return parent.id

    def rename_repertoire(self, repertoire_id: str, new_name: str) -> Repertoire:
        cleaned = (new_name or "").strip()
        if not cleaned:
            raise ValueError("name is empty")
        if len(cleaned) > 200:
            raise ValueError("name too long")
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        repertoire.name = cleaned
        self.repository.save_repertoire(repertoire)
        return repertoire

    def set_repertoire_active(self, repertoire_id: str, active: bool) -> Repertoire:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        repertoire.is_active = bool(active)
        self.repository.save_repertoire(repertoire)
        return repertoire

    def remove_repertoire(self, repertoire_id: str) -> None:
        self._load_repertoire_or_raise(repertoire_id)
        self.repository.delete_repertoire(repertoire_id)

    def tree_report(
        self,
        repertoire_id: str,
        *,
        filter_mode: str = "all",
        include_disabled: bool = False,
    ) -> OpeningTreeReport:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        all_items: List[OpeningTreeItem] = []
        self._collect_tree_items(repertoire.root_node, 0, all_items)
        included_ids = self._included_node_ids(all_items, filter_mode)
        visible = [
            item
            for item in all_items
            if (include_disabled or item.is_enabled) and item.node_id in included_ids
        ]
        return OpeningTreeReport(
            repertoire_id=repertoire.id,
            name=repertoire.name,
            color=repertoire.color,
            total_nodes=len(all_items),
            visible_nodes=visible,
        )

    def _candidate_moves(
        self,
        *,
        repertoire: Repertoire,
        node: OpeningNode,
        relative_ply: int,
        config: GenerateConfig,
    ):
        if node.side_to_move is (config.own_color or repertoire.color):
            if self._has_manual_prepared_child(node) and config.preserve_manual_prepared_moves:
                return
            for candidate in self._engine_candidates(node.fen, config.own_side_candidate_count):
                yield candidate.move_uci, MoveSource.GENERATED_STOCKFISH, candidate.evaluation, None
            return

        emitted = set()
        if config.opponent_mainline_source in {"stockfish", "mixed"}:
            for candidate in self._engine_candidates(node.fen, 1):
                emitted.add(candidate.move_uci)
                yield candidate.move_uci, MoveSource.GENERATED_STOCKFISH, candidate.evaluation, None

        threshold = maia_threshold_for_depth(relative_ply, config)
        for prediction in sorted(
            self.maia.predictions(node.fen),
            key=lambda item: item.probability,
            reverse=True,
        ):
            if prediction.probability < threshold:
                continue
            if prediction.move_uci in emitted:
                continue
            emitted.add(prediction.move_uci)
            yield prediction.move_uci, MoveSource.GENERATED_MAIA3, None, prediction.probability

    def _engine_candidates(self, fen: str, count: int) -> List[EngineMoveCandidate]:
        engine_config = EngineAnalysisConfig(
            depth=self.engine_config.depth,
            nodes=self.engine_config.nodes,
            time_ms=self.engine_config.time_ms,
            multipv=max(1, count),
        )
        analysis = self.engine.analyze_position(
            fen,
            engine_config,
        )
        candidates = []
        for candidate in analysis.candidates[:count]:
            candidates.append(
                EngineMoveCandidate(
                    move_uci=candidate.move_uci,
                    evaluation=candidate.evaluation_after,
                    rank=candidate.rank,
                )
            )
        return candidates

    def _has_manual_prepared_child(self, node: OpeningNode) -> bool:
        return any(
            child.is_user_prepared_move and child.source is MoveSource.MANUAL
            for child in node.children
        )

    def _manual_prepared_child_ucis(self, node: OpeningNode) -> Set[str]:
        return {
            child.move.uci
            for child in node.children
            if child.move
            and child.is_user_prepared_move
            and child.source is MoveSource.MANUAL
        }

    def _set_branch_enabled(self, node: OpeningNode, enabled: bool) -> None:
        node.is_enabled = enabled
        for child in node.children:
            self._set_branch_enabled(child, enabled)

    def _collect_tree_items(
        self,
        node: OpeningNode,
        depth: int,
        items: List[OpeningTreeItem],
    ) -> None:
        move = node.move
        items.append(
            OpeningTreeItem(
                node_id=node.id,
                parent_id=node.parent_id,
                depth=depth,
                san=move.san if move is not None else "root",
                uci=move.uci if move is not None else None,
                source=node.source,
                is_mainline=node.is_mainline,
                is_prepared=node.is_user_prepared_move,
                is_enabled=node.is_enabled,
                maia_probability=node.maia_probability,
                tags=list(node.tags),
                comment=node.comment,
            )
        )
        for child in node.children:
            self._collect_tree_items(child, depth + 1, items)

    def _matches_filter(self, item: OpeningTreeItem, filter_mode: str) -> bool:
        if filter_mode == "all":
            return True
        if filter_mode == "mainline":
            return item.is_mainline or item.depth == 0
        if filter_mode == "prepared":
            return item.is_prepared or item.depth == 0
        if filter_mode == "human-likely":
            return item.depth == 0 or (
                item.maia_probability is not None and item.maia_probability >= 0.10
            )
        if filter_mode == "engine":
            return item.depth == 0 or item.source is MoveSource.GENERATED_STOCKFISH
        if filter_mode == "mistake-traps":
            return "trap" in item.tags or "tactical-warning" in item.tags
        raise ValueError("unknown tree filter: {0}".format(filter_mode))

    def _included_node_ids(
        self,
        items: List[OpeningTreeItem],
        filter_mode: str,
    ) -> Set[str]:
        by_id = {item.node_id: item for item in items}
        included = set()
        for item in items:
            if not self._matches_filter(item, filter_mode):
                continue
            current = item
            while current is not None:
                included.add(current.node_id)
                current = by_id.get(current.parent_id) if current.parent_id is not None else None
        return included

    def _load_repertoire_or_raise(self, repertoire_id: str) -> Repertoire:
        repertoire = self.repository.load_repertoire(repertoire_id)
        if repertoire is None:
            raise ValueError("repertoire not found: {0}".format(repertoire_id))
        return repertoire

    def _find_node_or_raise(self, root: OpeningNode, node_id: str) -> OpeningNode:
        found = self._find_node(root, node_id)
        if found is None:
            raise ValueError("opening node not found: {0}".format(node_id))
        return found

    def _find_node(self, root: OpeningNode, node_id: str) -> Optional[OpeningNode]:
        if root.id == node_id:
            return root
        for child in root.children:
            found = self._find_node(child, node_id)
            if found is not None:
                return found
        return None
