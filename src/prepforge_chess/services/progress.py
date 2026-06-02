"""Derive human-facing training signals from stored TrainingProgress.

The `training_progress` table already records attempts, accuracy, spaced-
repetition score, and a `due_at` timestamp per node — but nothing surfaced it.
This module turns that raw data into two things the UI can show:

- a per-node *mastery* state (the Build/Train heatmap), and
- a per-repertoire *health* summary (Dashboard badge + Build header strip).

It is intentionally pure (no DB, no engine) so it is cheap to unit-test.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Dict, Iterable, Optional, Set

from prepforge_chess.core.models import Color, OpeningNode, TrainingProgress


# Mastery states, worst-to-best urgency order for the heatmap legend.
MASTERY_WEAK = "weak"          # low accuracy — most alarming (red)
MASTERY_DUE = "due"            # spaced-repetition says review now (amber)
MASTERY_LEARNING = "learning"  # tried, not yet solid (neutral)
MASTERY_MASTERED = "mastered"  # solid (green)
MASTERY_UNTRAINED = "untrained"  # never attempted (grey)

MASTERY_STATES = (
    MASTERY_MASTERED,
    MASTERY_LEARNING,
    MASTERY_DUE,
    MASTERY_WEAK,
    MASTERY_UNTRAINED,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    """Coerce a possibly-naive datetime to aware UTC for safe comparison."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def node_mastery(progress: Optional[TrainingProgress], *, now: Optional[datetime] = None) -> str:
    """Classify a single trainable node's mastery from its progress row."""
    if progress is None or progress.attempts <= 0:
        return MASTERY_UNTRAINED
    now = now or _now()
    ratio = progress.correct_attempts / progress.attempts if progress.attempts else 0.0
    # A move you keep getting wrong is the loudest signal, regardless of timing.
    if progress.attempts >= 2 and ratio < 0.5:
        return MASTERY_WEAK
    if progress.due_at is not None and _as_utc(progress.due_at) <= now:
        return MASTERY_DUE
    if progress.is_mastered or progress.spaced_repetition_score >= 7.0:
        return MASTERY_MASTERED
    return MASTERY_LEARNING


def _walk(root: OpeningNode) -> Iterable[OpeningNode]:
    stack = [root]
    while stack:
        node = stack.pop()
        yield node
        stack.extend(node.children)


def _is_trainable(node: OpeningNode, color: Color) -> bool:
    """A node the user actually drills: an enabled own-side move."""
    return (
        node.move is not None
        and node.move.side_to_move is color
        and node.is_enabled
    )


def mastery_map(
    root: OpeningNode,
    color: Color,
    progress_by_id: Dict[str, TrainingProgress],
    *,
    now: Optional[datetime] = None,
) -> Dict[str, str]:
    """Mastery state for every trainable (own-side) node, keyed by node id."""
    now = now or _now()
    out: Dict[str, str] = {}
    for node in _walk(root):
        if _is_trainable(node, color):
            out[node.id] = node_mastery(progress_by_id.get(node.id), now=now)
    return out


def due_node_ids(
    progress: Iterable[TrainingProgress],
    *,
    now: Optional[datetime] = None,
) -> Set[str]:
    """Node ids whose spaced-repetition review is due (or overdue)."""
    now = now or _now()
    due: Set[str] = set()
    for entry in progress:
        if entry.due_at is not None and _as_utc(entry.due_at) <= now:
            due.add(entry.node_id)
    return due


@dataclass(frozen=True)
class RepertoireHealth:
    trainable: int
    mastered: int
    weak: int
    due: int
    learning: int
    untrained: int
    mastery_pct: int
    shallow_lines: int

    def to_dict(self) -> Dict[str, int]:
        return asdict(self)


def _count_shallow_lines(root: OpeningNode, color: Color) -> int:
    """Leaf lines with fewer than two own-side prepared moves — i.e. branches
    that peter out too early to be real preparation."""
    shallow = 0

    def visit(node: OpeningNode, own_moves: int) -> None:
        nonlocal shallow
        enabled = [c for c in node.children if c.is_enabled]
        own = own_moves + (1 if _is_trainable(node, color) else 0)
        if not enabled:
            if own < 2:
                shallow += 1
            return
        for child in enabled:
            visit(child, own)

    for child in (c for c in root.children if c.is_enabled):
        visit(child, 0)
    return shallow


def compute_health(
    root: OpeningNode,
    color: Color,
    progress_by_id: Dict[str, TrainingProgress],
    *,
    now: Optional[datetime] = None,
) -> RepertoireHealth:
    states = mastery_map(root, color, progress_by_id, now=now)
    counts = {state: 0 for state in MASTERY_STATES}
    for state in states.values():
        counts[state] += 1
    trainable = len(states)
    mastery_pct = round(counts[MASTERY_MASTERED] / trainable * 100) if trainable else 0
    return RepertoireHealth(
        trainable=trainable,
        mastered=counts[MASTERY_MASTERED],
        weak=counts[MASTERY_WEAK],
        due=counts[MASTERY_DUE],
        learning=counts[MASTERY_LEARNING],
        untrained=counts[MASTERY_UNTRAINED],
        mastery_pct=mastery_pct,
        shallow_lines=_count_shallow_lines(root, color),
    )
