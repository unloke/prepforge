from __future__ import annotations

import math
import json
import re
import uuid
from dataclasses import dataclass, field
from typing import List, Optional, Set, Tuple

from prepforge_chess.core.limits import (
    MAX_PLAN_CHANGES,
    MAX_PLAN_DEPTH,
    MAX_PLAN_PV_LENGTH,
    MAX_ADD_MOVES_BATCH,
    MAX_DELETE_NODES_BATCH,
)
from prepforge_chess.core.chess_core import STARTING_FEN, ChessCore
from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    MoveSource,
    OpeningNode,
    Repertoire,
)
from prepforge_chess.storage.repositories.repertoires import RepertoireRepository


MAINLINE_THRESHOLD = 0.10


@dataclass
class PlanSummary:
    added_nodes: int = 0
    updated_nodes: int = 0
    high_probability_unprepared: int = 0


def child_by_uci(node: OpeningNode, move_uci: str) -> Optional[OpeningNode]:
    return next((child for child in node.children if child.move and child.move.uci == move_uci), None)


@dataclass(frozen=True)
class CreateRepertoireRequest:
    name: str
    color: Color
    root_fen: str = STARTING_FEN
    notes: Optional[str] = None
    tags: List[str] = field(default_factory=list)


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

# A coordinate UCI move: from-square, to-square, optional promotion piece.
_UCI_RE = re.compile(r"^[a-h][1-8][a-h][1-8][qrbnQRBN]?$")


def _looks_like_uci(value) -> bool:
    return isinstance(value, str) and bool(_UCI_RE.match(value))


def _engine_eval_from_payload(data) -> Optional[EngineEvaluation]:
    """Rebuild an EngineEvaluation (White-POV) from a build plan's JSON, or None.

    The browser computed the Stockfish eval; the server runs NO engine, it only
    stores what the client sent (mirrors Phase 2 classify-save trusting browser
    evals). A malformed shape
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
        repository: RepertoireRepository,
        chess_core: Optional[ChessCore] = None,
    ):
        self.repository = repository
        self.chess_core = chess_core or ChessCore()


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
        repertoire: Optional[Repertoire] = None,
    ) -> OpeningNode:
        repertoire = repertoire or self._load_repertoire_or_raise(repertoire_id)
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
            self.repository.save_changed_nodes(repertoire_id, [existing])
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
        self.repository.save_changed_nodes(repertoire_id, [child])
        return child


    def apply_generation_plan(
        self,
        repertoire_id: str,
        root_node_id: str,
        plan: dict,
        *, receipt_target: Optional[tuple] = None,
    ) -> Tuple[Repertoire, PlanSummary]:
        """Apply a browser-produced Build-Generate plan (Phase 3c, no compute).

        The browser ran the whole generation recursion locally (Stockfish +
        Maia3 in the user's browser) and submits a tree-mutation plan; the server
        runs NO engine. It RE-VALIDATES every move's legality and parentage,
        RECOMPUTES the persisted flags (``is_mainline`` /
        ``is_user_prepared_move``) itself rather than trusting the client, and
        persists.

        All-or-nothing: the repertoire is saved once at the very end, so a
        malformed change (illegal move, unknown parent, bad source) raises before
        any persistence — a partial plan never lands.
        """
        if not isinstance(plan, dict):
            raise ValueError("plan must be an object")
        # A stale or wrong-anchor plan must NOT be applied to a different anchor:
        # the planner returns the root it was built from, so a mismatch means the
        # plan and the request disagree about where it lands — reject, never guess.
        plan_root = plan.get("rootNodeId")
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
        before = self._node_snapshot(repertoire.root_node)

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

        summary = PlanSummary()
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
            elif action == "set_mainline":
                self._apply_plan_set_mainline(
                    change, nodes_by_id, temp_to_node, summary
                )
            else:
                raise ValueError("unknown plan change action: {0!r}".format(action))

        self.applied_plan_id_map = {ref: node.id for ref, node in temp_to_node.items()}
        receipt = None
        if receipt_target:
            owner, key, digest = receipt_target
            receipt = (owner, key, {"digest": digest, "id_map": self.applied_plan_id_map, "summary": {
                "added_nodes": summary.added_nodes, "updated_nodes": summary.updated_nodes,
                "high_probability_unprepared": summary.high_probability_unprepared,
            }})
        self.repository.save_changed_nodes(
            repertoire_id, self._changed_nodes(repertoire, before), receipt=receipt
        )
        return repertoire, summary

    def add_moves_batch(
        self,
        repertoire_id: str,
        moves: list,
        *, receipt_target: Optional[tuple] = None,
    ) -> Tuple[Repertoire, PlanSummary, dict]:
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
        before = self._node_snapshot(repertoire.root_node)
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

        summary = PlanSummary()
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

        receipt = (*receipt_target, {"id_map": id_map}) if receipt_target else None
        self.repository.save_changed_nodes(repertoire_id, self._changed_nodes(repertoire, before), receipt=receipt)
        return repertoire, summary, id_map

    @staticmethod
    def _node_snapshot(root: OpeningNode) -> dict:
        def state(node: OpeningNode) -> tuple:
            return (
                node.is_mainline, node.is_user_prepared_move, node.is_enabled,
                node.maia_probability, node.engine_evaluation, node.source,
                node.comment, tuple(node.tags), tuple(node.arrows), tuple(node.circles),
            )

        result = {}
        stack = [root]
        while stack:
            node = stack.pop()
            result[node.id] = state(node)
            stack.extend(node.children)
        return result

    def _changed_nodes(self, repertoire: Repertoire, before: dict) -> List[OpeningNode]:
        after = self._node_snapshot(repertoire.root_node)
        changed = set(after) - set(before)
        changed.update(node_id for node_id in before if after.get(node_id) != before[node_id])
        nodes = []
        stack = [repertoire.root_node]
        while stack:
            node = stack.pop()
            if node.id in changed:
                nodes.append(node)
            stack.extend(node.children)
        return nodes

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
        summary: PlanSummary,
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
        if probability is not None and probability >= MAINLINE_THRESHOLD:
            summary.high_probability_unprepared += 1

    def _apply_plan_update(
        self, change: dict, nodes_by_id: dict, summary: PlanSummary
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

    def _apply_plan_set_mainline(
        self,
        change: dict,
        nodes_by_id: dict,
        temp_to_node: dict,
        summary: PlanSummary,
    ) -> None:
        # Promote a node to the mainline among its siblings (the browser emits this when the
        # opponent's Stockfish best should take over from a generated mainline). Re-validated
        # here: scoped to the anchor subtree, and a user-authored (MANUAL / IMPORTED_PGN)
        # mainline sibling is NEVER demoted — never trust the client to clobber user intent.
        ref = change.get("nodeRef")
        if not ref or not isinstance(ref, str):
            raise ValueError("set_mainline requires a nodeRef string")
        node = temp_to_node.get(ref) or nodes_by_id.get(ref)
        if node is None:
            raise ValueError(
                "set_mainline nodeRef {0!r} is not a node in this subtree".format(ref)
            )
        if node.parent_id is None:
            return  # the anchor has no siblings to rebalance
        parent = nodes_by_id.get(node.parent_id)
        if parent is None:
            return
        if any(
            sibling.is_mainline
            and sibling.source in {MoveSource.MANUAL, MoveSource.IMPORTED_PGN}
            for sibling in parent.children
            if sibling is not node
        ):
            return  # preserve a user-authored mainline
        changed = False
        for sibling in parent.children:
            target = sibling is node
            if sibling.is_mainline != target:
                sibling.is_mainline = target
                changed = True
        if changed:
            summary.updated_nodes += 1

    def _merge_plan_fields(
        self,
        node: OpeningNode,
        evaluation: Optional[EngineEvaluation],
        probability: Optional[float],
        source: Optional[MoveSource],
        summary: PlanSummary,
    ) -> None:
        # Fill-only-when-null + protected-source guard — identical to the
        # stored child (never overwrite a value the
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
        self.repository.update_opening_nodes(repertoire_id, [
            {"id": child.id, "is_mainline": child.is_mainline}
            for child in (parent.children if node.parent_id is not None else [node])
        ])
        return node

    def mark_prepared(
        self, repertoire_id: str, node_id: str, prepared: bool = True,
        *, repertoire: Optional[Repertoire] = None,
    ) -> OpeningNode:
        repertoire = repertoire or self._load_repertoire_or_raise(repertoire_id)
        self.loaded_repertoire = repertoire
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        node.is_user_prepared_move = prepared
        self.repository.update_opening_nodes(repertoire_id, [
            {"id": node.id, "is_user_prepared_move": prepared}
        ])
        return node

    def disable_branch(
        self, repertoire_id: str, node_id: str, *, repertoire: Optional[Repertoire] = None,
    ) -> OpeningNode:
        repertoire = repertoire or self._load_repertoire_or_raise(repertoire_id)
        self.loaded_repertoire = repertoire
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        self._set_branch_enabled(node, False)
        self.repository.update_opening_nodes(repertoire_id, [
            {"id": child.id, "is_enabled": False}
            for child in self.repository._walk_nodes(node)
        ])
        return node

    def enable_branch(
        self, repertoire_id: str, node_id: str, *, repertoire: Optional[Repertoire] = None,
    ) -> OpeningNode:
        repertoire = repertoire or self._load_repertoire_or_raise(repertoire_id)
        self.loaded_repertoire = repertoire
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        self._set_branch_enabled(node, True)
        # A-02: a node is only reachable through ENABLED ancestors, so
        # re-enabling a branch also re-enables its ancestor chain. "Enabled"
        # then means exactly one thing everywhere: the node is trainable again
        # (health stats and the scheduler agree by construction).
        ancestors = []
        current = node
        while current.parent_id is not None:
            parent = self._find_node_or_raise(repertoire.root_node, current.parent_id)
            if not parent.is_enabled:
                parent.is_enabled = True
                ancestors.append(parent)
            current = parent
        self.repository.update_opening_nodes(
            repertoire_id,
            [
                {"id": child.id, "is_enabled": True}
                for child in self.repository._walk_nodes(node)
            ]
            + [{"id": parent.id, "is_enabled": True} for parent in ancestors],
        )
        return node

    def add_comment(self, repertoire_id: str, node_id: str, comment: str) -> OpeningNode:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        node.comment = comment
        self.repository.update_opening_nodes(repertoire_id, [{"id": node.id, "comment": comment}])
        return node

    def add_tag(self, repertoire_id: str, node_id: str, tag: str) -> OpeningNode:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        node = self._find_node_or_raise(repertoire.root_node, node_id)
        if tag not in node.tags:
            node.tags.append(tag)
        self.repository.update_opening_nodes(repertoire_id, [
            {"id": node.id, "tags_json": json.dumps(node.tags)}
        ])
        return node

    def set_annotations(
        self,
        repertoire_id: str,
        node_id: str,
        arrows: List[str],
        circles: List[str],
    ) -> None:
        self.repository.set_node_annotations(repertoire_id, node_id, list(arrows), list(circles))

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
        self.repository.delete_opening_nodes(repertoire_id, removed_ids)
        return parent.id

    def delete_nodes_batch(self, repertoire_id: str, node_ids: List[str], *, receipt_target: Optional[tuple] = None) -> List[str]:
        """Delete a batch of subtrees in one load + one persist (local-first flush).

        Idempotent per id: an id that no longer exists — already deleted, or
        removed as a descendant of an earlier id in the same batch — is skipped,
        because the client queues deletes optimistically and an over-delete must
        not fail the whole flush. The root position is never deletable. Returns
        every removed node id (subtree roots plus their descendants).
        """
        if not isinstance(node_ids, list):
            raise ValueError("node_ids must be a list")
        if len(node_ids) > MAX_DELETE_NODES_BATCH:
            raise ValueError(
                "too many nodes in batch ({0} > {1})".format(
                    len(node_ids), MAX_DELETE_NODES_BATCH
                )
            )
        repertoire = self._load_repertoire_or_raise(repertoire_id)

        removed_ids: List[str] = []

        def collect(target: OpeningNode) -> None:
            removed_ids.append(target.id)
            for child in target.children:
                collect(child)

        for node_id in node_ids:
            if not node_id or not isinstance(node_id, str):
                raise ValueError("each node id must be a non-empty string")
            node = self._find_node(repertoire.root_node, node_id)
            if node is None:
                continue  # already gone — idempotent skip
            if node.parent_id is None:
                raise ValueError("cannot delete the root position")
            parent = self._find_node(repertoire.root_node, node.parent_id)
            if parent is None:
                continue
            collect(node)
            parent.children = [c for c in parent.children if c.id != node_id]

        receipt = (*receipt_target, {"removed_node_ids": removed_ids}) if receipt_target else None
        if removed_ids:
            self.repository.delete_opening_nodes(repertoire_id, removed_ids, receipt=receipt)
        elif receipt is not None:
            self.repository.set_user_setting(*receipt)
        return removed_ids

    def rename_repertoire(self, repertoire_id: str, new_name: str) -> Repertoire:
        cleaned = (new_name or "").strip()
        if not cleaned:
            raise ValueError("name is empty")
        if len(cleaned) > 200:
            raise ValueError("name too long")
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        repertoire.name = cleaned
        self.repository.update_repertoire_fields(repertoire_id, name=cleaned)
        return repertoire

    def set_repertoire_active(self, repertoire_id: str, active: bool) -> Repertoire:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        repertoire.is_active = bool(active)
        self.repository.update_repertoire_fields(repertoire_id, is_active=int(bool(active)))
        return repertoire

    def tree_report(
        self,
        repertoire_id: str,
        *,
        filter_mode: str = "all",
        include_disabled: bool = False,
        repertoire: Optional[Repertoire] = None,
    ) -> OpeningTreeReport:
        repertoire = repertoire or self._load_repertoire_or_raise(repertoire_id)
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
                item.maia_probability is not None and item.maia_probability >= MAINLINE_THRESHOLD
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
        if filter_mode == "all":
            return {item.node_id for item in items}
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
        self.loaded_repertoire = repertoire
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
