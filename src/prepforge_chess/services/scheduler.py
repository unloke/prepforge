"""Smart-queue card scheduler (Train v2, Phase 1).

The card is the trainer's new unit of work, replacing whole leaf lines. Each
card targets one own-move node to recall — or a short run of *consecutive*
own moves merged into a multi-target card — and carries a ``kind`` saying why
it was scheduled, so the UI can show the queue's composition and switch new
cards into teach-then-test mode:

- ``weak``   — answered wrong more often than right; always first.
- ``due``    — spaced repetition says review now.
- ``new``    — never attempted; introduced shallow-first, capped per session
               so a fresh repertoire doesn't bury the player.
- ``polish`` — learning/mastered material used to top a session up.

Like ``services/progress.py`` this module is pure (no DB, no engine): tree +
stored ``TrainingProgress`` in, a ``SessionPlan`` out. Sessions are small
(~12 targets) so training has a beginning and an end, not an endless grind.

Cards are encoded as compact ``kind:first:last`` strings and stored in the
existing ``TrainingSession.line_order`` JSON column — no schema change. The
path root→``last_target`` is unique in a tree, so those two node ids fully
determine the run-in, the prompts in between, and the opponent replies.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from prepforge_chess.core.models import Color, OpeningNode, TrainingProgress
from prepforge_chess.services.progress import (
    MASTERY_DUE,
    MASTERY_UNTRAINED,
    MASTERY_WEAK,
    mastery_map,
)

CARD_WEAK = "weak"
CARD_DUE = "due"
CARD_NEW = "new"
CARD_POLISH = "polish"

# Lower number = more urgent; a merged card takes the most urgent kind.
_KIND_PRIORITY = {CARD_WEAK: 0, CARD_DUE: 1, CARD_NEW: 2, CARD_POLISH: 3}

DEFAULT_SESSION_SIZE = 12
DEFAULT_NEW_CAP = 4
DEFAULT_MAX_TARGETS_PER_CARD = 3
# Plies auto-played before the first prompt so the player lands in context
# (the opponent's last move is the recall cue) without re-answering the prefix.
RUN_IN_PLIES = 3

_FAR_FUTURE = datetime.max.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class TrainingCard:
    kind: str
    first_target_id: str
    last_target_id: str


@dataclass(frozen=True)
class SessionPlan:
    cards: List[TrainingCard]
    # kind -> card count, plus "cards" and "targets" totals (for the queue
    # composition strip: "3 weak · 4 due · 3 new").
    counts: Dict[str, int]


def encode_card(card: TrainingCard) -> str:
    return "{0}:{1}:{2}".format(card.kind, card.first_target_id, card.last_target_id)


def decode_card(raw: object) -> Optional[TrainingCard]:
    """Parse an encoded card; ``None`` for anything malformed (a legacy line id
    that leaked into a smart session, a kind we no longer know, ...)."""
    if not isinstance(raw, str):
        return None
    parts = raw.split(":")
    if len(parts) != 3 or parts[0] not in _KIND_PRIORITY or not parts[1] or not parts[2]:
        return None
    return TrainingCard(kind=parts[0], first_target_id=parts[1], last_target_id=parts[2])


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


def path_to_node(root: OpeningNode, node_id: str) -> List[OpeningNode]:
    """Nodes from the first move down to ``node_id`` inclusive (root excluded).
    Raises ``ValueError`` when the node is not in the tree."""
    path: List[OpeningNode] = []

    def visit(node: OpeningNode, current: List[OpeningNode]) -> bool:
        if node.id == node_id:
            path.extend(current)
            return True
        for child in node.children:
            if visit(child, current + [child]):
                return True
        return False

    if root.id == node_id:
        return []
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
    share it — that is the whole point of card-based training."""
    out: List[_Candidate] = []
    counter = [0]

    def visit(node: OpeningNode, prev_own_id: Optional[str], family_id: Optional[str]) -> None:
        for child in node.children:
            if not child.is_enabled:
                continue
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
    seed: Optional[int] = None,
    session_size: int = DEFAULT_SESSION_SIZE,
    new_cap: int = DEFAULT_NEW_CAP,
    max_targets_per_card: int = DEFAULT_MAX_TARGETS_PER_CARD,
    now: Optional[datetime] = None,
) -> SessionPlan:
    rng = random.Random(seed)
    candidates = _collect_candidates(root, color)
    if not candidates:
        return SessionPlan(cards=[], counts=card_counts([]))
    states = mastery_map(root, color, progress_by_id, now=now)

    weak: List[_Candidate] = []
    due: List[_Candidate] = []
    new: List[_Candidate] = []
    polish: List[_Candidate] = []
    for cand in candidates:
        state = states.get(cand.node.id)
        if state == MASTERY_WEAK:
            weak.append(cand)
        elif state == MASTERY_DUE:
            due.append(cand)
        elif state == MASTERY_UNTRAINED:
            new.append(cand)
        else:
            polish.append(cand)

    def accuracy(cand: _Candidate) -> float:
        progress = progress_by_id.get(cand.node.id)
        if progress is None or progress.attempts <= 0:
            return 1.0
        return progress.correct_attempts / progress.attempts

    def due_key(cand: _Candidate) -> Tuple[datetime, int]:
        progress = progress_by_id.get(cand.node.id)
        due_at = progress.due_at if progress is not None and progress.due_at else _FAR_FUTURE
        if due_at.tzinfo is None:
            due_at = due_at.replace(tzinfo=timezone.utc)
        return (due_at, cand.order)

    weak.sort(key=lambda c: (accuracy(c), -(progress_by_id[c.node.id].attempts if c.node.id in progress_by_id else 0), c.order))
    due.sort(key=due_key)
    new.sort(key=lambda c: (c.ply, c.order))  # shallow lines first
    polish.sort(key=due_key)  # soonest-due first: closest to slipping

    selected_kind: Dict[str, str] = {}

    def take(pool: List[_Candidate], kind: str, limit: Optional[int] = None) -> None:
        room = session_size - len(selected_kind)
        if limit is not None:
            room = min(room, limit)
        for cand in pool[: max(0, room)]:
            selected_kind[cand.node.id] = kind

    take(weak, CARD_WEAK)
    take(due, CARD_DUE)
    take(new, CARD_NEW, limit=new_cap)
    take(polish, CARD_POLISH)

    cards = _merge_into_cards(candidates, selected_kind, max_targets_per_card)
    ordered = _order_cards(cards, {c.node.id: c for c in candidates}, rng)
    counts = card_counts(ordered)
    counts["targets"] = len(selected_kind)
    return SessionPlan(cards=ordered, counts=counts)


@dataclass
class _CardDraft:
    kind: str
    first_target_id: str
    last_target_id: str
    targets: int


def _merge_into_cards(
    candidates: List[_Candidate],
    selected_kind: Dict[str, str],
    max_targets_per_card: int,
) -> List[TrainingCard]:
    """Fold consecutive selected own moves on one path into multi-target cards.

    Candidates arrive in preorder, so an ancestor is always processed before
    its descendants; keying drafts by their current tail means a second branch
    hanging off the same ancestor finds the tail already moved and starts its
    own card. ``new`` targets never merge — they are taught one at a time.
    """
    drafts: List[_CardDraft] = []
    draft_by_tail: Dict[str, _CardDraft] = {}
    for cand in candidates:
        kind = selected_kind.get(cand.node.id)
        if kind is None:
            continue
        draft = draft_by_tail.get(cand.prev_own_id) if cand.prev_own_id else None
        if (
            draft is not None
            and kind != CARD_NEW
            and draft.kind != CARD_NEW
            and draft.targets < max_targets_per_card
        ):
            del draft_by_tail[draft.last_target_id]
            draft.last_target_id = cand.node.id
            draft.targets += 1
            if _KIND_PRIORITY[kind] < _KIND_PRIORITY[draft.kind]:
                draft.kind = kind
            draft_by_tail[cand.node.id] = draft
        else:
            draft = _CardDraft(
                kind=kind,
                first_target_id=cand.node.id,
                last_target_id=cand.node.id,
                targets=1,
            )
            drafts.append(draft)
            draft_by_tail[cand.node.id] = draft
    return [
        TrainingCard(
            kind=d.kind, first_target_id=d.first_target_id, last_target_id=d.last_target_id
        )
        for d in drafts
    ]


def _order_cards(
    cards: List[TrainingCard],
    candidate_by_id: Dict[str, _Candidate],
    rng: random.Random,
) -> List[TrainingCard]:
    """Urgency bands (weak, due, new, polish), shuffled within each band, then
    a greedy pass so two cards from the same opening family don't sit next to
    each other when any alternative exists — variety is what keeps the queue
    from feeling like the same line on repeat."""
    bands: Dict[str, List[TrainingCard]] = {k: [] for k in _KIND_PRIORITY}
    for card in cards:
        bands[card.kind].append(card)
    ordered: List[TrainingCard] = []
    for kind in (CARD_WEAK, CARD_DUE, CARD_NEW, CARD_POLISH):
        band = bands[kind]
        rng.shuffle(band)
        ordered.extend(band)

    def family(card: TrainingCard) -> str:
        cand = candidate_by_id.get(card.first_target_id)
        return cand.family_id if cand is not None else card.first_target_id

    for i in range(1, len(ordered)):
        if family(ordered[i]) != family(ordered[i - 1]):
            continue
        for j in range(i + 1, len(ordered)):
            if family(ordered[j]) != family(ordered[i - 1]):
                ordered[i], ordered[j] = ordered[j], ordered[i]
                break
    return ordered
