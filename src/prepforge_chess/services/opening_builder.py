from __future__ import annotations

import math
import re
import uuid
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Set, Tuple

from prepforge_chess.core.chess_core import STARTING_FEN, ChessCore
from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
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


# Sources a browser-submitted generation plan may add or upgrade. The plan comes
# from an untrusted client, so it can only carry GENERATED moves — never inject a
# MANUAL / IMPORTED_PGN authorship that would dodge the protected-source guards.
_PLAN_GENERATED_SOURCES = frozenset(
    {MoveSource.GENERATED_STOCKFISH, MoveSource.GENERATED_MAIA3}
)

# apply-plan is an UNTRUSTED, public, no-compute endpoint, so a single submitted
# plan must not be able to force the server into unbounded apply/tree-walk/save
# work (or a too-deep tree that overruns Python's recursion limit). These caps
# sit far above any legitimate UI configuration (ply depth caps at 20, branch
# count is small) — they only fence off hostile/buggy payloads.
MAX_PLAN_CHANGES = 2000
MAX_PLAN_DEPTH = 64  # planned-node depth measured from the anchor
MAX_PLAN_PV_LENGTH = 64

# A local-first Build flush (add_moves_batch) is also an untrusted, no-compute
# write. Same intent as MAX_PLAN_CHANGES: fence off a hostile/buggy batch from
# forcing unbounded apply + tree-walk work. Sits far above any realistic burst of
# hand-played moves a user could queue between debounced flushes.
MAX_ADD_MOVES_BATCH = 500

# A coordinate UCI move: from-square, to-square, optional promotion piece.
_UCI_RE = re.compile(r"^[a-h][1-8][a-h][1-8][qrbnQRBN]?$")


def _looks_like_uci(value) -> bool:
    return isinstance(value, str) and bool(_UCI_RE.match(value))


def _engine_eval_from_payload(data) -> Optional[EngineEvaluation]:
    """Rebuild an EngineEvaluation (White-POV) from a build plan's JSON, or None.

    The browser computed the Stockfish eval; the server runs NO engine, it only
    stores what the client sent (mirrors Phase 2 classify-save trusting browser
    evals). Reverse of ``web.server._engine_eval_to_json``. A malformed shape
    raises ValueError (→ 400); a missing eval is simply None (eval is optional
    metadata, not a hard requirement of a generated node). Validation is shape
    only — bounded ``pv`` of UCI-ish strings, finite numeric ``wdl`` — to keep
    garbage out of the DB, not to re-derive any chess truth.
    """
    if data is None:
        return None
    if not isinstance(data, dict):
        raise ValueError("engineEvaluation must be an object or null")

    def _opt_int(value) -> Optional[int]:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ValueError("engineEvaluation numeric fields must be integers")

    pv = data.get("pv") or []
    if not isinstance(pv, list):
        raise ValueError("engineEvaluation.pv must be a list")
    if len(pv) > MAX_PLAN_PV_LENGTH:
        raise ValueError(
            "engineEvaluation.pv is too long ({0} > {1})".format(len(pv), MAX_PLAN_PV_LENGTH)
        )
    parsed_pv: List[str] = []
    for move in pv:
        if not _looks_like_uci(move):
            raise ValueError("engineEvaluation.pv entries must be UCI strings")
        parsed_pv.append(move)

    best_move = data.get("best_move_uci")
    if best_move is not None and not _looks_like_uci(best_move):
        raise ValueError("engineEvaluation.best_move_uci must be a UCI string or null")

    wdl = data.get("wdl")
    parsed_wdl: Optional[dict] = None
    if wdl is not None:
        if not isinstance(wdl, dict):
            raise ValueError("engineEvaluation.wdl must be an object or null")
        parsed_wdl = {}
        for key, raw in wdl.items():
            try:
                value = float(raw)
            except (TypeError, ValueError):
                raise ValueError("engineEvaluation.wdl values must be numbers")
            if not math.isfinite(value):
                raise ValueError("engineEvaluation.wdl values must be finite")
            parsed_wdl[str(key)] = value

    return EngineEvaluation(
        engine=str(data.get("engine") or "stockfish (browser)"),
        depth=_opt_int(data.get("depth")),
        score_cp=_opt_int(data.get("score_cp")),
        mate_in=_opt_int(data.get("mate_in")),
        best_move_uci=best_move,
        pv=parsed_pv,
        wdl=parsed_wdl,
    )


def _coerce_plan_probability(value) -> Optional[float]:
    if value is None:
        return None
    try:
        prob = float(value)
    except (TypeError, ValueError):
        raise ValueError("maiaProbability must be a number or null")
    if not math.isfinite(prob) or prob < 0.0 or prob > 1.0:
        raise ValueError("maiaProbability must be a finite number in [0, 1]")
    return prob


def _validate_plan_source(value) -> MoveSource:
    try:
        source = MoveSource(value)
    except ValueError:
        raise ValueError("plan source must be a valid move source, got {0!r}".format(value))
    if source not in _PLAN_GENERATED_SOURCES:
        raise ValueError(
            "plan may only add/upgrade generated moves (generated_stockfish / "
            "generated_maia3), not {0}".format(source.value)
        )
    return source


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
        # Maia is optional at construction. Pure data operations — create/rename/delete
        # and `tree_report` serialization — never touch the human model, so the
        # "server stores data, never computes chess" path (the FastAPI port) can build a
        # service without one. The no-silent-fake guarantee is preserved, just deferred:
        # the loud failure now fires on `self.maia` access (the `maia` property), which
        # only the move-generation path reaches, instead of at construction.
        self._maia = maia

    @property
    def maia(self) -> MaiaAdapter:
        if self._maia is None:
            raise ValueError(
                "OpeningBuilderService requires a Maia adapter for move generation. "
                "Pass create_maia3_adapter(...) in production, or an explicit stub in "
                "tests. (Pure data/serialization operations do not need one.)"
            )
        return self._maia

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
            # Label only (the human model this repertoire will be generated with);
            # fall back to the default when no Maia is wired (data-only construction).
            human_model=self._maia.name if self._maia is not None else "maia3",
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

    def apply_generation_plan(
        self,
        repertoire_id: str,
        root_node_id: str,
        plan: dict,
    ) -> Tuple[Repertoire, GenerationSummary]:
        """Apply a browser-produced Build-Generate plan (Phase 3c, no compute).

        The browser ran the whole generation recursion locally (Stockfish +
        Maia3 in the user's browser) and submits a tree-mutation plan; the server
        runs NO engine. It RE-VALIDATES every move's legality and parentage,
        RECOMPUTES the persisted flags (``is_mainline`` /
        ``is_user_prepared_move``) itself rather than trusting the client, and
        persists. Parity with ``_upsert_child`` / ``_expand``.

        All-or-nothing: the repertoire is saved once at the very end, so a
        malformed change (illegal move, unknown parent, bad source) raises before
        any persistence — a partial plan never lands.
        """
        if not isinstance(plan, dict):
            raise ValueError("plan must be an object")
        # A stale or wrong-anchor plan must NOT be applied to a different anchor:
        # the planner returns the root it was built from, so a mismatch means the
        # plan and the request disagree about where it lands — reject, never guess.
        plan_root = plan.get("rootNodeId") or plan.get("root_node_id")
        if plan_root and plan_root != root_node_id:
            raise ValueError("plan.rootNodeId does not match root_node_id")
        changes = plan.get("changes")
        if not isinstance(changes, list):
            raise ValueError("plan.changes must be a list")
        if len(changes) > MAX_PLAN_CHANGES:
            raise ValueError(
                "plan has too many changes ({0} > {1})".format(
                    len(changes), MAX_PLAN_CHANGES
                )
            )

        repertoire = self._load_repertoire_or_raise(repertoire_id)
        anchor = self._find_node_or_raise(repertoire.root_node, root_node_id)

        # parentRef / nodeId resolve ONLY within the anchor subtree: the browser
        # generated under this anchor, so scoping every write here stops a stray
        # or hostile plan from mutating nodes elsewhere in the repertoire. Depths
        # are tracked alongside so a new node's depth-from-anchor can be capped.
        nodes_by_id: dict = {}
        depth_by_id: dict = {}
        self._index_subtree(anchor, 0, nodes_by_id, depth_by_id)
        # Freshly planned nodes are addressed by a same-run tempId so a child
        # change can parent onto a sibling added earlier in the same plan; the
        # plan is emitted in DFS order (parents first), so a single forward pass
        # resolves every reference. tempIds are validated unique + 'tmp-'-prefixed
        # so a forged/duplicate id can't silently rebind a later parentRef.
        temp_to_node: dict = {}
        seen_temp_ids: set = set()

        summary = GenerationSummary()
        for change in changes:
            if not isinstance(change, dict):
                raise ValueError("each plan change must be an object")
            action = change.get("action")
            if action == "planned_add":
                self._apply_plan_add(
                    change,
                    repertoire,
                    nodes_by_id,
                    depth_by_id,
                    temp_to_node,
                    seen_temp_ids,
                    summary,
                )
            elif action == "updated":
                self._apply_plan_update(change, nodes_by_id, summary)
            else:
                raise ValueError("unknown plan change action: {0!r}".format(action))

        self.repository.save_repertoire(repertoire)
        return repertoire, summary

    def add_moves_batch(
        self,
        repertoire_id: str,
        moves: list,
    ) -> Tuple[Repertoire, GenerationSummary, dict]:
        """Append a batch of MANUAL moves in one all-or-nothing persist.

        The manual sibling of ``apply_generation_plan``: the browser plays moves
        locally (local-first Build) and flushes them as a debounced batch; the
        server runs NO chess engine. It RE-VALIDATES every move's legality and
        parentage, RECOMPUTES the persisted flags (``is_mainline`` /
        ``is_user_prepared_move``) itself rather than trusting the client, FORCES
        ``source = MANUAL``, dedupes against existing children, and persists once
        at the very end (a single malformed move raises before anything lands).
        Returns the repertoire, a summary, and the ``tmp- -> real`` id_map the
        client uses to reconcile its optimistic nodes.

        Differences from apply-plan, by design: these are hand-played moves, so
        the source is always MANUAL (apply-plan forbids it as anti-spoof) and a
        move may parent anywhere in the repertoire — ``parentRef`` resolves
        against the WHOLE tree, not a single anchor subtree. Per-move flag rules
        mirror the ``/api/build/add-move`` endpoint (prepared on the owner's
        turn; the first enabled child of a parent becomes the mainline).
        """
        if not isinstance(moves, list):
            raise ValueError("moves must be a list")
        if len(moves) > MAX_ADD_MOVES_BATCH:
            raise ValueError(
                "too many moves in batch ({0} > {1})".format(
                    len(moves), MAX_ADD_MOVES_BATCH
                )
            )

        repertoire = self._load_repertoire_or_raise(repertoire_id)
        # parentRef / tempId resolve against the whole tree (manual moves can
        # attach anywhere). depth_by_id from the index is unused for the cap below.
        nodes_by_id: dict = {}
        depth_by_id: dict = {}
        self._index_subtree(repertoire.root_node, 0, nodes_by_id, depth_by_id)

        temp_to_node: dict = {}
        seen_temp_ids: set = set()
        # Batch-relative depth: every already-persisted node is a valid anchor at
        # depth 0, so the cap bounds only how deep THIS batch extends a line. A
        # long pre-existing repertoire line is never penalised, but a hostile
        # 500-link chain still can't overrun the recursion limit on the next walk.
        temp_depth: dict = {}

        summary = GenerationSummary()
        id_map: dict = {}
        for move in moves:
            if not isinstance(move, dict):
                raise ValueError("each move must be an object")
            move_uci = move.get("uci")
            if not move_uci or not isinstance(move_uci, str):
                raise ValueError("each move requires a uci string")
            temp_id = self._validate_plan_temp_id(
                move.get("tempId"), seen_temp_ids, nodes_by_id
            )
            seen_temp_ids.add(temp_id)
            parent_ref = move.get("parentRef")
            parent = self._resolve_plan_parent(parent_ref, nodes_by_id, temp_to_node)

            is_prepared = parent.side_to_move is repertoire.color
            existing = child_by_uci(parent, move_uci)
            if existing is not None:
                # Dedupe — parity with add_move's existing-child branch: prepared
                # is OR-merged and the prepared tag added once; no new node, no
                # added count. A real persisted node is a fresh anchor (depth 0).
                existing.is_user_prepared_move = (
                    existing.is_user_prepared_move or is_prepared
                )
                if is_prepared and "prepared" not in existing.tags:
                    existing.tags.append("prepared")
                temp_to_node[temp_id] = existing
                temp_depth[temp_id] = 0
                id_map[temp_id] = existing.id
                continue

            child_depth = temp_depth.get(parent_ref, 0) + 1
            if child_depth > MAX_PLAN_DEPTH:
                raise ValueError(
                    "batch exceeds the max depth {0} from an existing node".format(
                        MAX_PLAN_DEPTH
                    )
                )

            # New child — re-validate legality SERVER-SIDE. apply_uci raises on an
            # illegal/unparseable move, aborting the whole batch before any save.
            move_obj = self.chess_core.apply_uci(
                parent.fen, move_uci, source=MoveSource.MANUAL
            )
            # is_mainline / is_user_prepared_move are RECOMPUTED, never trusted
            # from the client — same rule the add-move endpoint applies.
            is_mainline = not any(child.is_enabled for child in parent.children)
            child = OpeningNode(
                id=str(uuid.uuid4()),
                repertoire_id=repertoire.id,
                parent_id=parent.id,
                move=move_obj,
                fen=move_obj.fen_after,
                side_to_move=self.chess_core.side_to_move(move_obj.fen_after),
                is_mainline=is_mainline,
                is_user_prepared_move=is_prepared,
                tags=["prepared"] if is_prepared else [],
                source=MoveSource.MANUAL,
            )
            parent.children.append(child)
            nodes_by_id[child.id] = child
            temp_to_node[temp_id] = child
            temp_depth[temp_id] = child_depth
            id_map[temp_id] = child.id
            summary.added_nodes += 1
            summary.changes.append(
                GeneratedNodeChange(child.id, move_uci, "added", MoveSource.MANUAL)
            )

        self.repository.save_repertoire(repertoire)
        return repertoire, summary, id_map

    def _index_subtree(
        self, node: OpeningNode, depth: int, nodes_into: dict, depth_into: dict
    ) -> None:
        nodes_into[node.id] = node
        depth_into[node.id] = depth
        for child in node.children:
            self._index_subtree(child, depth + 1, nodes_into, depth_into)

    def _resolve_plan_parent(
        self, parent_ref, nodes_by_id: dict, temp_to_node: dict
    ) -> OpeningNode:
        if not parent_ref or not isinstance(parent_ref, str):
            raise ValueError("planned_add requires a parentRef string")
        # A same-run tempId wins over a node id (they never collide: tmp- prefix).
        if parent_ref in temp_to_node:
            return temp_to_node[parent_ref]
        parent = nodes_by_id.get(parent_ref)
        if parent is None:
            raise ValueError(
                "planned_add parentRef {0!r} is not a node in this subtree".format(
                    parent_ref
                )
            )
        return parent

    @staticmethod
    def _validate_plan_temp_id(temp_id, seen_temp_ids: set, nodes_by_id: dict) -> str:
        # Every planned add MUST carry a unique, well-formed temp id so later
        # children can parent onto it deterministically; a duplicate or a value
        # colliding with a real node id could rebind a later parentRef to the
        # wrong node and let a malformed plan be accepted as a different tree.
        if not isinstance(temp_id, str) or not temp_id.startswith("tmp-"):
            raise ValueError(
                "planned_add requires a tempId string with a 'tmp-' prefix"
            )
        if temp_id in seen_temp_ids:
            raise ValueError("duplicate tempId in plan: {0}".format(temp_id))
        if temp_id in nodes_by_id:
            raise ValueError(
                "tempId collides with an existing node id: {0}".format(temp_id)
            )
        return temp_id

    def _apply_plan_add(
        self,
        change: dict,
        repertoire: Repertoire,
        nodes_by_id: dict,
        depth_by_id: dict,
        temp_to_node: dict,
        seen_temp_ids: set,
        summary: GenerationSummary,
    ) -> None:
        move_uci = change.get("moveUci")
        if not move_uci or not isinstance(move_uci, str):
            raise ValueError("planned_add requires a moveUci string")
        temp_id = self._validate_plan_temp_id(
            change.get("tempId"), seen_temp_ids, nodes_by_id
        )
        seen_temp_ids.add(temp_id)
        source = _validate_plan_source(change.get("source"))
        parent = self._resolve_plan_parent(
            change.get("parentRef"), nodes_by_id, temp_to_node
        )
        evaluation = _engine_eval_from_payload(change.get("engineEvaluation"))
        probability = _coerce_plan_probability(change.get("maiaProbability"))

        # Server state may have drifted since the browser loaded the tree (a
        # concurrent edit added this move): if it already exists under the parent,
        # MERGE instead of creating a duplicate — same as _upsert_child's
        # existing-child branch. The tempId still maps to the resolved node so
        # later children parented on it resolve (and inherit its depth).
        existing = child_by_uci(parent, move_uci)
        if existing is not None:
            self._merge_plan_fields(existing, evaluation, probability, source, summary)
            temp_to_node[temp_id] = existing
            return

        child_depth = depth_by_id[parent.id] + 1
        if child_depth > MAX_PLAN_DEPTH:
            raise ValueError(
                "plan exceeds the max depth {0} from the anchor".format(MAX_PLAN_DEPTH)
            )

        # New child — re-validate legality SERVER-SIDE. apply_uci raises on an
        # illegal/unparseable move, which aborts the whole apply before any save.
        move = self.chess_core.apply_uci(parent.fen, move_uci, source=source)
        # is_mainline / is_user_prepared_move are RECOMPUTED here, never taken from
        # the plan (intendedMainline is INTENT only): a node can't claim mainline
        # if a sibling already owns it, and prepared is keyed to repertoire color.
        is_mainline = bool(change.get("intendedMainline")) and not any(
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
        nodes_by_id[child.id] = child
        depth_by_id[child.id] = child_depth
        temp_to_node[temp_id] = child
        summary.added_nodes += 1
        summary.changes.append(GeneratedNodeChange(child.id, move_uci, "added", source))
        if probability is not None and probability >= MAINLINE_THRESHOLD:
            summary.high_probability_unprepared += 1

    def _apply_plan_update(
        self, change: dict, nodes_by_id: dict, summary: GenerationSummary
    ) -> None:
        node_id = change.get("nodeId")
        if not node_id or not isinstance(node_id, str):
            raise ValueError("updated change requires a nodeId string")
        node = nodes_by_id.get(node_id)
        if node is None:
            raise ValueError(
                "updated change nodeId {0!r} is not a node in this subtree".format(
                    node_id
                )
            )
        evaluation = _engine_eval_from_payload(change.get("engineEvaluation"))
        probability = _coerce_plan_probability(change.get("maiaProbability"))
        raw_source = change.get("source")
        source = _validate_plan_source(raw_source) if raw_source is not None else None
        self._merge_plan_fields(node, evaluation, probability, source, summary)

    def _merge_plan_fields(
        self,
        node: OpeningNode,
        evaluation: Optional[EngineEvaluation],
        probability: Optional[float],
        source: Optional[MoveSource],
        summary: GenerationSummary,
    ) -> None:
        # Fill-only-when-null + protected-source guard — identical to the
        # existing-child branch of _upsert_child (never overwrite a value the
        # node already has, never relabel a user-authored move).
        changed = False
        if evaluation is not None and node.engine_evaluation is None:
            node.engine_evaluation = evaluation
            changed = True
        if probability is not None and node.maia_probability is None:
            node.maia_probability = probability
            changed = True
        if (
            source is not None
            and node.source not in {MoveSource.MANUAL, MoveSource.IMPORTED_PGN}
            and node.source != source
        ):
            node.source = source
            changed = True
        if changed:
            summary.updated_nodes += 1
            summary.changes.append(
                GeneratedNodeChange(
                    node.id,
                    node.move.uci if node.move else "",
                    "updated",
                    node.source,
                )
            )

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
