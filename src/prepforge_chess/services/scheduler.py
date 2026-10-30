"""Smart-queue scheduler: which moves a session drills, and in what order.

FSRS schedules every own move (node) on its own; a session groups the chosen
moves into *lines* (Chessable MoveTrainer / Listudy style). A card walks one
path from move 1: own moves that are not due are auto-played, only the card's
targets are prompted and graded. Each card carries a ``kind`` saying why it
was scheduled, so the UI can show the queue's composition and teach new moves:

- ``weak``   — missed recently and not yet stable again; leads the session but is
               capped at ``WEAK_SHARE`` of it so urgent material never starves
               due/new review (leftover weak tops the session off when the other
               pools run dry).
- ``due``    — FSRS says review now.
- ``new``    — never attempted; introduced shallow-first, capped per session
               so a fresh repertoire doesn't bury the player.
- ``polish`` — learning/mastered material used to top a session up.

Urgency chooses the targets; the selected lines follow repertoire and tree
DFS order so sibling branches come back to back. Like ``services/progress.py``
this module is pure (no DB, no engine): tree + stored ``TrainingProgress`` in,
a ``SessionPlan`` out. Sessions are small (~12 targets) so training has a
beginning and an end. Cards are stored as ``kind:repertoire_id:t1,t2,…``
strings in ``TrainingSession.line_order``.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

from prepforge_chess.core.models import Color, OpeningNode, TrainingProgress
from prepforge_chess.services.progress import (
    MASTERY_DUE,
    MASTERY_UNTRAINED,
    MASTERY_WEAK,
    effective_children,
    node_mastery,
)
from prepforge_chess.services.srs import retrievability

CARD_WEAK = "weak"
CARD_DUE = "due"
CARD_NEW = "new"
CARD_POLISH = "polish"
CARD_KINDS = (
    {"key": CARD_WEAK, "label": "Weak spot", "title": "Missed recently"},
    {"key": CARD_DUE, "label": "Due review", "title": "Spaced repetition says now"},
    {"key": CARD_NEW, "label": "New move", "title": "Shown once, then tested"},
    {"key": CARD_POLISH, "label": "Polish", "title": "Kept warm with an occasional rep"},
)

# Lower number = more urgent; a merged card takes the most urgent kind.
_KIND_PRIORITY = {kind["key"]: index for index, kind in enumerate(CARD_KINDS)}

DEFAULT_SESSION_SIZE = 12
DEFAULT_NEW_CAP = 4
DEFAULT_MAX_TARGETS_PER_CARD = 4
# Weak cards are the most urgent but not the whole story: without a cap, a pile of
# weak targets (e.g. after a rushed first pass over an imported repertoire) can fill
# every session forever, and due/new material never reaches the queue. Weak may claim
# at most this fraction of a normally-sized session up front; whatever it leaves is
# filled due → new → polish, and any leftover weak targets top the session off only
# when the other pools run dry.
WEAK_SHARE = 0.6

_FAR_FUTURE = datetime.max.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class TrainingCard:
    """One line of work: the graded own moves on a single root-to-node path,
    in path order. The session plays the line from move 1; own moves on it
    that are not targets are auto-played."""
    kind: str
    repertoire_id: str
    target_ids: Tuple[str, ...]

    @property
    def first_target_id(self) -> str:
        return self.target_ids[0]

    @property
    def last_target_id(self) -> str:
        return self.target_ids[-1]


@dataclass(frozen=True)
class SessionPlan:
    cards: List[TrainingCard]
    # kind -> card count, plus "cards" and "targets" totals (for the queue
    # composition strip: "3 weak · 4 due · 3 new").
    counts: Dict[str, int]


def encode_card(card: TrainingCard) -> str:
    return "{0}:{1}:{2}".format(card.kind, card.repertoire_id, ",".join(card.target_ids))


def decode_card(raw: object) -> Optional[TrainingCard]:
    """Parse ``kind:repertoire:t1,t2,…``; return None for malformed values."""
    if not isinstance(raw, str):
        return None
    parts = raw.split(":")
    if len(parts) != 3 or parts[0] not in _KIND_PRIORITY or not parts[1]:
        return None
    targets = tuple(parts[2].split(","))
    if not all(targets):
        return None
    return TrainingCard(parts[0], parts[1], targets)


def card_counts(cards: Iterable[Optional[TrainingCard]]) -> Dict[str, int]:
    counts = {CARD_WEAK: 0, CARD_DUE: 0, CARD_NEW: 0, CARD_POLISH: 0, "cards": 0}
    for card in cards:
        if card is None:
            continue
        counts[card.kind] += 1
        counts["cards"] += 1
    return counts


# --------------------------------------------------------------------------
# Tree helpers (shared with SmartTrainingService; root-exclusive paths, same
# semantics as TrainingService._path_to_node).


def index_nodes(root: OpeningNode) -> Dict[str, OpeningNode]:
    """Map every node id in the tree to its node, in one pass. Built once per
    repertoire load and reused for O(1) lookups and parent-walk paths, so the
    hot read paths (resume checks, per-card bundle) never re-DFS the whole tree."""
    out: Dict[str, OpeningNode] = {}
    stack = [root]
    while stack:
        node = stack.pop()
        out[node.id] = node
        stack.extend(node.children)
    return out


def sibling_moves(
    root: OpeningNode, path: List[OpeningNode], node: OpeningNode
) -> List[OpeningNode]:
    """Other enabled moves the repertoire keeps at ``node``'s position (its
    siblings). Playing one is in the repertoire, just not the move being drilled."""
    pos = next((i for i, p in enumerate(path) if p.id == node.id), None)
    if pos is None:
        return []
    parent = path[pos - 1] if pos > 0 else root
    return [c for c in parent.children if c.id != node.id and c.is_enabled and c.move is not None]


def path_to_node(
    root: OpeningNode,
    node_id: str,
    *,
    index: Optional[Dict[str, OpeningNode]] = None,
) -> List[OpeningNode]:
    """Nodes from the first move down to ``node_id`` inclusive (root excluded).
    Raises ``ValueError`` when the node is not in the tree.

    When ``index`` (an ``index_nodes`` map for the same tree) is supplied the
    path is rebuilt by walking ``parent_id`` pointers up to the root — O(depth)
    and no per-call tree DFS. The fallback DFS keeps the helper usable without a
    prebuilt index (and preserves the exact not-found semantics: a node that is
    not a descendant of ``root`` raises)."""
    if root.id == node_id:
        return []

    if index is not None:
        chain: List[OpeningNode] = []
        cur: Optional[OpeningNode] = index.get(node_id)
        while cur is not None and cur.id != root.id:
            chain.append(cur)
            cur = index.get(cur.parent_id) if cur.parent_id else None
        if cur is None or cur.id != root.id:
            raise ValueError("opening node not found: {0}".format(node_id))
        chain.reverse()
        return chain

    path: List[OpeningNode] = []

    def visit(node: OpeningNode, current: List[OpeningNode]) -> bool:
        if node.id == node_id:
            path.extend(current)
            return True
        for child in node.children:
            if visit(child, current + [child]):
                return True
        return False

    if not visit(root, []):
        raise ValueError("opening node not found: {0}".format(node_id))
    return path


def own_move_nodes_on(path: Sequence[OpeningNode], color: Color) -> List[OpeningNode]:
    return [
        node
        for node in path
        if node.move is not None and node.move.side_to_move is color and node.is_enabled
    ]


@dataclass(frozen=True)
class _Candidate:
    node: OpeningNode
    order: int  # preorder position, for stable tie-breaks and ancestor-first merging
    ply: int
    prev_own_id: Optional[str]  # the previous own move on this node's path
    family_id: str  # the path's first move — "which opening is this"


def _collect_candidates(root: OpeningNode, color: Color) -> List[_Candidate]:
    """Every trainable own-move node reachable through enabled children, in
    preorder. Each node appears exactly once no matter how many leaf lines
    share it — that is the whole point of card-based training.

    A-02: the descent shares ``progress.effective_children`` with the health
    walk — a disabled node makes its whole subtree unreachable for BOTH, so
    the scheduler's candidate set always equals health's trainable set."""
    out: List[_Candidate] = []
    counter = [0]

    def visit(node: OpeningNode, prev_own_id: Optional[str], family_id: Optional[str]) -> None:
        for child in effective_children(node):
            child_family = family_id or child.id
            trainable = child.move is not None and child.move.side_to_move is color
            if trainable:
                out.append(
                    _Candidate(
                        node=child,
                        order=counter[0],
                        ply=child.move.ply if child.move is not None else 0,
                        prev_own_id=prev_own_id,
                        family_id=child_family,
                    )
                )
                counter[0] += 1
            visit(child, child.id if trainable else prev_own_id, child_family)

    visit(root, None, None)
    return out


# --------------------------------------------------------------------------
# Plan building


def build_session_plan(
    root: OpeningNode,
    color: Color,
    progress_by_id: Dict[str, TrainingProgress],
    *,
    session_size: int = DEFAULT_SESSION_SIZE,
    new_cap: int = DEFAULT_NEW_CAP,
    max_targets_per_card: int = DEFAULT_MAX_TARGETS_PER_CARD,
    now: Optional[datetime] = None,
    target_node_ids: Optional[Sequence[str]] = None,
) -> SessionPlan:
    candidates = _collect_candidates(root, color)
    requested = set(target_node_ids or [])
    candidate_ids = {c.node.id for c in candidates}
    if requested - candidate_ids:
        raise ValueError("practice targets must be enabled own moves in this repertoire")
    if not candidates:
        return SessionPlan(cards=[], counts=card_counts([]))
    # Classify mastery only for the candidates we actually schedule. The old
    # ``mastery_map`` did a second full-tree walk that also descended into
    # disabled subtrees (which ``_collect_candidates`` already pruned) and
    # produced states for nodes the plan never reads.
    eval_now = now or datetime.now(timezone.utc)

    weak: List[_Candidate] = []
    due: List[_Candidate] = []
    new: List[_Candidate] = []
    polish: List[_Candidate] = []
    for cand in candidates:
        state = node_mastery(progress_by_id.get(cand.node.id), now=eval_now)
        if state == MASTERY_WEAK:
            weak.append(cand)
        elif state == MASTERY_DUE:
            due.append(cand)
        elif state == MASTERY_UNTRAINED:
            new.append(cand)
        else:
            polish.append(cand)

    def recall(cand: _Candidate) -> float:
        """Weak ordering: the move FSRS thinks is most forgotten leads."""
        return retrievability(progress_by_id.get(cand.node.id), now=eval_now)

    def due_key(cand: _Candidate) -> Tuple[datetime, int]:
        progress = progress_by_id.get(cand.node.id)
        due_at = progress.due_at if progress is not None and progress.due_at else _FAR_FUTURE
        return (due_at, cand.order)

    weak.sort(
        key=lambda c: (
            recall(c),
            -(progress_by_id[c.node.id].attempts if c.node.id in progress_by_id else 0),
            c.order,
        )
    )
    due.sort(key=due_key)
    new.sort(key=lambda c: (c.ply, c.order))  # shallow lines first
    polish.sort(key=due_key)  # soonest-due first: closest to slipping

    selected_kind: Dict[str, str] = {}

    def take(pool: List[_Candidate], kind: str, limit: Optional[int] = None) -> None:
        room = session_size - len(selected_kind)
        if limit is not None:
            room = min(room, limit)
        # Skip candidates this or an earlier pass already selected: the weak
        # top-off re-uses the same (sorted) pool, so it must pick up the
        # REMAINDER, not re-take the head.
        for cand in pool:
            if room <= 0:
                break
            if cand.node.id in selected_kind:
                continue
            selected_kind[cand.node.id] = kind
            room -= 1

    # Urgency with variety: weak leads but may claim at most 60% of the session up
    # front (WEAK_SHARE). The remaining capacity is allocated in order due → new
    # (<= new_cap) → polish, and only when those pools run dry do the leftover weak
    # targets top the session off — weak material is still the best available thing
    # to drill, it just doesn't get to monopolise the queue.
    # Explicit practice reserves at most half the queue, keeping room for
    # ordinary weak/due review. Reuse mastery kinds so grading stays unchanged.
    target_budget = max(1, session_size // 2)
    for pool, kind in ((weak, CARD_WEAK), (due, CARD_DUE), (new, CARD_NEW), (polish, CARD_POLISH)):
        take([c for c in pool if c.node.id in requested], kind,
             limit=max(0, target_budget - len(selected_kind)))
    targeted_new = sum(kind == CARD_NEW for kind in selected_kind.values())
    weak_share = max(1, int((session_size - len(selected_kind)) * WEAK_SHARE))
    take(weak, CARD_WEAK, limit=weak_share)
    take(due, CARD_DUE)
    take(new, CARD_NEW, limit=max(0, new_cap - targeted_new))
    take(polish, CARD_POLISH)
    take(weak, CARD_WEAK)  # top off with leftover weak when nothing else remains

    cards = _group_into_lines(candidates, selected_kind, max_targets_per_card, root.repertoire_id, requested)
    ordered = order_lines(cards, {c.node.id: c.order for c in candidates})
    # Explicit practice opens the session: the move the user asked for is card 1.
    ordered.sort(key=lambda card: card.first_target_id not in requested)
    counts = card_counts(ordered)
    counts["targets"] = len(selected_kind)
    return SessionPlan(cards=ordered, counts=counts)


@dataclass
class _LineDraft:
    kind: str
    target_ids: List[str]


def _group_into_lines(
    candidates: List[_Candidate],
    selected_kind: Dict[str, str],
    max_targets_per_card: int,
    repertoire_id: str,
    requested: Set[str] = frozenset(),
) -> List[TrainingCard]:
    """Group the selected own moves into lines (Chessable/Listudy style).

    A selected move joins the line ending at its nearest selected own-move
    ancestor, so one card walks one path from move 1 and prompts only its
    targets; the unselected own moves between them are auto-played.
    Candidates arrive in preorder, so the first branch under an ancestor
    extends its line and each sibling branch starts its own (it replays the
    shared prefix). New moves group only with new moves (a new line is taught
    in one pass), reviews with reviews; a requested target opens its own card.
    """
    by_id = {cand.node.id: cand for cand in candidates}
    drafts: List[_LineDraft] = []
    draft_by_tail: Dict[str, _LineDraft] = {}
    for cand in candidates:
        kind = selected_kind.get(cand.node.id)
        if kind is None:
            continue
        ancestor = cand.prev_own_id
        while ancestor is not None and ancestor not in selected_kind:
            parent = by_id.get(ancestor)
            ancestor = parent.prev_own_id if parent is not None else None
        draft = draft_by_tail.get(ancestor) if ancestor is not None else None
        if (
            draft is not None
            and cand.node.id not in requested
            and (kind == CARD_NEW) == (draft.kind == CARD_NEW)
            and len(draft.target_ids) < max_targets_per_card
        ):
            del draft_by_tail[ancestor]
            draft.target_ids.append(cand.node.id)
            if _KIND_PRIORITY[kind] < _KIND_PRIORITY[draft.kind]:
                draft.kind = kind
        else:
            draft = _LineDraft(kind=kind, target_ids=[cand.node.id])
            drafts.append(draft)
        draft_by_tail[cand.node.id] = draft
    return [
        TrainingCard(kind=d.kind, repertoire_id=repertoire_id, target_ids=tuple(d.target_ids))
        for d in drafts
    ]


# Session bands: weak lines lead, then reviews (due and polish), then new lines.
_BAND = {CARD_WEAK: 0, CARD_DUE: 1, CARD_POLISH: 1, CARD_NEW: 2}


def order_lines(
    cards: Sequence[TrainingCard],
    preorder: Dict[str, int],
    repertoire_rank: Optional[Dict[str, int]] = None,
) -> List[TrainingCard]:
    """Serve the selected material in repertoire/tree order. Urgency already
    chose which targets enter the session; it must not split related lines
    into separate bands that replay the same opening later in the session."""
    rank = repertoire_rank or {}
    return sorted(
        cards,
        key=lambda card: (
            rank.get(card.repertoire_id, 0),
            preorder.get(card.first_target_id, 0),
            _BAND[card.kind],
        ),
    )


# --------------------------------------------------------------------------
# Mixed sessions: one queue over several repertoires.


def mix_plans(
    plans: Sequence[Tuple[str, SessionPlan, Dict[str, int]]],
) -> SessionPlan:
    """Merge per-repertoire plans into one queue: each repertoire's lines
    stay together in tree order, and the repertoire with
    the most urgent head goes first."""
    cards: List[TrainingCard] = []
    preorder: Dict[str, int] = {}
    heads = []
    for repertoire_id, plan, order in plans:
        if not plan.cards:
            continue
        cards.extend(plan.cards)
        preorder.update(order)
        heads.append((min(_BAND[card.kind] for card in plan.cards), len(heads), repertoire_id))
    rank = {repertoire_id: index for index, (_, _, repertoire_id) in enumerate(sorted(heads))}
    ordered = order_lines(cards, preorder, rank)
    counts = card_counts(ordered)
    counts["targets"] = sum(plan.counts.get("targets", 0) for _, plan, _ in plans)
    return SessionPlan(cards=ordered, counts=counts)


def preorder_index(root: OpeningNode, color: Color) -> Dict[str, int]:
    """Own-move node id -> DFS preorder position (the order lines are served)."""
    return {cand.node.id: cand.order for cand in _collect_candidates(root, color)}
