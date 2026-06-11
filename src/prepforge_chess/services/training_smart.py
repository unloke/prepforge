"""Card-based smart trainer service (Train v2, Phase 1).

Orchestrates ``TrainingMode.SMART`` sessions over the card queues built by
``services/scheduler.py``. Kept separate from ``TrainingService`` on purpose:
the legacy line-walking modes stay untouched while this grows.

Session state reuses the existing ``TrainingSession`` row unchanged:
- ``line_order``       — encoded cards (``kind:first:last``), not leaf ids,
- ``current_index``    — which card,
- ``current_node_id``  — the pending target inside the card (None = first).

Grading contract: the client reports an ``attempt`` number per prompt and the
server writes spaced-repetition progress **only for attempt 1** — retries and
the play-after-reveal move advance the session but never inflate accuracy
(the legacy trainer counted copying the revealed answer as a correct attempt).
A second wrong attempt re-queues the card a few positions later in the same
session, which replaces the legacy end-of-session recovery round.

Prompts deliberately include the expected move and hint texts: this is the
player's own repertoire, not a quiz with secrets, and shipping them lets the
client run the retry/teach flows without extra round-trips.
"""
from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Dict, List, Optional

from prepforge_chess.core.models import (
    OpeningNode,
    Repertoire,
    TrainingMode,
    TrainingProgress,
    TrainingSession,
)
from prepforge_chess.services.scheduler import (
    RUN_IN_PLIES,
    SessionPlan,
    TrainingCard,
    build_session_plan,
    card_counts,
    decode_card,
    encode_card,
    own_move_nodes_on,
    path_to_node,
)
from prepforge_chess.services.training import record_attempt
from prepforge_chess.services.training_view import heuristic_strategy, piece_name_at
from prepforge_chess.storage.repositories import PrepForgeRepository

# A re-queued card comes back after this many other cards — soon enough that
# the position is still warm, far enough that it's recall rather than echo.
REQUEUE_GAP = 3


@dataclass(frozen=True)
class SmartPrompt:
    session_id: str
    repertoire_id: str
    card_index: int
    total_cards: int
    kind: str
    target_index: int  # 0-based position inside the card
    targets_total: int
    expected_node_id: str
    expected_move_uci: str
    expected_move_san: str
    fen_before: str
    # Context the client animates before prompting: board starts at start_fen
    # and the run_in moves play out, ending at fen_before.
    start_fen: str
    run_in: List[OpeningNode]
    hint_strategy: str
    hint_piece: str
    # True when hint_strategy is the AUTHOR's own annotation (strategic idea / plan /
    # comment) rather than a generic heuristic — the client keeps author words
    # verbatim but replaces heuristics with a board-derived explanation.
    hint_is_annotation: bool = False


@dataclass(frozen=True)
class SmartMoveResult:
    correct: bool
    attempt: int
    sr_written: bool
    played_uci: str
    expected_uci: str
    expected_san: str
    card_completed: bool
    session_completed: bool
    requeued: bool
    session: TrainingSession
    progress: Optional[TrainingProgress]
    next_prompt: Optional[SmartPrompt]
    played_san: Optional[str] = None
    fen_after_player: Optional[str] = None
    reply_uci: Optional[str] = None
    reply_san: Optional[str] = None
    fen_after_reply: Optional[str] = None


@dataclass(frozen=True)
class _CardContext:
    session: TrainingSession
    repertoire: Repertoire
    card: TrainingCard
    path: List[OpeningNode]
    targets: List[OpeningNode]  # own moves from first_target to last_target
    expected: OpeningNode
    expected_target_index: int


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class SmartTrainingService:
    def __init__(self, repository: PrepForgeRepository):
        self.repository = repository

    # ------------------------------------------------------------------ start

    def start_or_resume(
        self,
        repertoire_id: str,
        *,
        fresh: bool = False,
        session_size: Optional[int] = None,
        new_cap: Optional[int] = None,
        seed: Optional[int] = None,
    ) -> TrainingSession:
        """Resume an unfinished, still-intact smart session, else build a new
        queue from current mastery. ``fresh`` forces a rebuild (the explicit
        "start over" button)."""
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        existing = self.repository.load_latest_training_session(
            repertoire_id, TrainingMode.SMART
        )
        if existing is not None and not fresh and self._resumable(existing, repertoire):
            return existing

        progress_by_id = {
            p.node_id: p for p in self.repository.list_training_progress(repertoire_id)
        }
        actual_seed = seed if seed is not None else random.SystemRandom().randint(1, 2**31 - 1)
        kwargs = {"seed": actual_seed}
        if session_size is not None:
            kwargs["session_size"] = session_size
        if new_cap is not None:
            kwargs["new_cap"] = new_cap
        plan: SessionPlan = build_session_plan(
            repertoire.root_node, repertoire.color, progress_by_id, **kwargs
        )
        if not plan.cards:
            raise ValueError("repertoire has no trainable moves yet")

        line_order = [encode_card(card) for card in plan.cards]
        if existing is not None:
            session = replace(
                existing,
                line_order=line_order,
                current_index=0,
                current_node_id=None,
                mistakes=[],
                seed=actual_seed,
                updated_at=_utc_now(),
            )
        else:
            session = TrainingSession(
                id=str(uuid.uuid4()),
                repertoire_id=repertoire_id,
                mode=TrainingMode.SMART,
                line_order=line_order,
                current_index=0,
                seed=actual_seed,
            )
        self.repository.save_training_session(session)
        return session

    def counts(self, session: TrainingSession) -> Dict[str, int]:
        return card_counts(decode_card(raw) for raw in session.line_order)

    def _resumable(self, session: TrainingSession, repertoire: Repertoire) -> bool:
        if not session.line_order or session.current_index >= len(session.line_order):
            return False
        node_ids = set()
        stack = [repertoire.root_node]
        while stack:
            node = stack.pop()
            node_ids.add(node.id)
            stack.extend(node.children)
        for raw in session.line_order:
            card = decode_card(raw)
            if card is None:
                return False
            if card.first_target_id not in node_ids or card.last_target_id not in node_ids:
                return False
        return True

    # ----------------------------------------------------------------- prompt

    def current_prompt(self, session_id: str) -> Optional[SmartPrompt]:
        session = self._load_session_or_raise(session_id)
        repertoire = self._load_repertoire_or_raise(session.repertoire_id)
        context = self._context(session, repertoire)
        return self._prompt_from_context(context) if context is not None else None

    def skip_card(self, session_id: str) -> Optional[SmartPrompt]:
        session = self._load_session_or_raise(session_id)
        repertoire = self._load_repertoire_or_raise(session.repertoire_id)
        if session.current_index >= len(session.line_order):
            return None
        session = replace(
            session,
            current_index=session.current_index + 1,
            current_node_id=None,
            updated_at=_utc_now(),
        )
        self.repository.save_training_session(session)
        context = self._context(session, repertoire)
        return self._prompt_from_context(context) if context is not None else None

    def _context(
        self, session: TrainingSession, repertoire: Repertoire
    ) -> Optional[_CardContext]:
        """Resolve the current card to live tree nodes, skipping (and
        persisting past) cards whose targets were edited away in Build."""
        while session.current_index < len(session.line_order):
            card = decode_card(session.line_order[session.current_index])
            context = self._card_context(session, repertoire, card) if card else None
            if context is not None:
                return context
            session = replace(
                session,
                current_index=session.current_index + 1,
                current_node_id=None,
                updated_at=_utc_now(),
            )
            self.repository.save_training_session(session)
        return None

    def _card_context(
        self,
        session: TrainingSession,
        repertoire: Repertoire,
        card: TrainingCard,
    ) -> Optional[_CardContext]:
        try:
            path = path_to_node(repertoire.root_node, card.last_target_id)
        except ValueError:
            return None
        own = own_move_nodes_on(path, repertoire.color)
        first_index = next(
            (i for i, node in enumerate(own) if node.id == card.first_target_id), None
        )
        if first_index is None:
            return None
        targets = own[first_index:]
        if not targets:
            return None
        expected_target_index = next(
            (i for i, node in enumerate(targets) if node.id == session.current_node_id),
            0,
        )
        expected = targets[expected_target_index]
        if expected.move is None:
            return None
        return _CardContext(
            session=session,
            repertoire=repertoire,
            card=card,
            path=path,
            targets=targets,
            expected=expected,
            expected_target_index=expected_target_index,
        )

    def _prompt_from_context(self, context: _CardContext) -> SmartPrompt:
        expected = context.expected
        move = expected.move
        path_pos = next(i for i, node in enumerate(context.path) if node.id == expected.id)
        run_in = [
            node
            for node in context.path[max(0, path_pos - RUN_IN_PLIES) : path_pos]
            if node.move is not None
        ]
        start_fen = run_in[0].move.fen_before if run_in else move.fen_before
        piece = piece_name_at(move.fen_before, move.uci)
        annotation = (
            expected.strategic_idea or expected.typical_plan or (expected.comment or "")
        ).strip()
        strategy = annotation or heuristic_strategy(move.san, piece)
        return SmartPrompt(
            session_id=context.session.id,
            repertoire_id=context.session.repertoire_id,
            card_index=context.session.current_index,
            total_cards=len(context.session.line_order),
            kind=context.card.kind,
            target_index=context.expected_target_index,
            targets_total=len(context.targets),
            expected_node_id=expected.id,
            expected_move_uci=move.uci,
            expected_move_san=move.san,
            fen_before=move.fen_before,
            start_fen=start_fen,
            run_in=run_in,
            hint_strategy=strategy,
            hint_piece="Move the {0}".format(piece) if piece else "Find the move",
            hint_is_annotation=bool(annotation),
        )

    # ------------------------------------------------------------------- move

    def submit_move(
        self, session_id: str, played_uci: str, *, attempt: int = 1
    ) -> SmartMoveResult:
        session = self._load_session_or_raise(session_id)
        repertoire = self._load_repertoire_or_raise(session.repertoire_id)
        context = self._context(session, repertoire)
        if context is None:
            raise ValueError("training session has no current prompt")
        session = context.session  # _context may have skipped stale cards
        expected = context.expected
        move = expected.move
        correct = played_uci == move.uci

        progress: Optional[TrainingProgress] = None
        sr_written = attempt <= 1
        if sr_written:
            stored = self.repository.load_training_progress(
                repertoire.id, expected.id
            ) or TrainingProgress(node_id=expected.id)
            session, progress = record_attempt(
                session=session,
                progress=stored,
                node_id=expected.id,
                correct=correct,
            )
            self.repository.save_training_progress(repertoire.id, progress)

        card_completed = False
        requeued = False
        if correct:
            if context.expected_target_index + 1 < len(context.targets):
                session = replace(
                    session,
                    current_node_id=context.targets[context.expected_target_index + 1].id,
                    updated_at=_utc_now(),
                )
            else:
                card_completed = True
                session = replace(
                    session,
                    current_index=session.current_index + 1,
                    current_node_id=None,
                    updated_at=_utc_now(),
                )
        else:
            session = replace(
                session, current_node_id=expected.id, updated_at=_utc_now()
            )
            if attempt >= 2:
                session, requeued = self._requeue_card(session, context.card)

        self.repository.save_training_session(session)

        played_san = fen_after_player = None
        reply_uci = reply_san = fen_after_reply = None
        if correct:
            played_san = move.san
            fen_after_player = move.fen_after
            reply = self._reply_after(context, expected)
            if reply is not None and reply.move is not None:
                reply_uci = reply.move.uci
                reply_san = reply.move.san
                fen_after_reply = reply.move.fen_after

        next_context = self._context(session, repertoire)
        next_prompt = (
            self._prompt_from_context(next_context) if next_context is not None else None
        )
        return SmartMoveResult(
            correct=correct,
            attempt=attempt,
            sr_written=sr_written,
            played_uci=played_uci,
            expected_uci=move.uci,
            expected_san=move.san,
            card_completed=card_completed,
            session_completed=next_prompt is None,
            requeued=requeued,
            session=session,
            progress=progress,
            next_prompt=next_prompt,
            played_san=played_san,
            fen_after_player=fen_after_player,
            reply_uci=reply_uci,
            reply_san=reply_san,
            fen_after_reply=fen_after_reply,
        )

    def _requeue_card(
        self, session: TrainingSession, card: TrainingCard
    ) -> tuple[TrainingSession, bool]:
        """After a second wrong attempt, schedule the card again a few
        positions ahead — unless an identical copy is already pending, so a
        stubborn miss queues one retry at a time instead of stacking up."""
        encoded = encode_card(card)
        if encoded in session.line_order[session.current_index + 1 :]:
            return session, False
        line_order = list(session.line_order)
        insert_at = min(session.current_index + REQUEUE_GAP, len(line_order))
        line_order.insert(insert_at, encoded)
        return replace(session, line_order=line_order, updated_at=_utc_now()), True

    def _reply_after(
        self, context: _CardContext, expected: OpeningNode
    ) -> Optional[OpeningNode]:
        """The opponent move the client animates after a correct answer: the
        next node on the card's path, or — past the last target — the first
        enabled child, so even a card's final move gets its "it worked" beat."""
        for index, node in enumerate(context.path):
            if node.id == expected.id:
                if index + 1 < len(context.path):
                    return context.path[index + 1]
                break
        return next((c for c in expected.children if c.is_enabled), None)

    # ---------------------------------------------------------------- loaders

    def _load_repertoire_or_raise(self, repertoire_id: str) -> Repertoire:
        repertoire = self.repository.load_repertoire(repertoire_id)
        if repertoire is None:
            raise ValueError("repertoire not found: {0}".format(repertoire_id))
        return repertoire

    def _load_session_or_raise(self, session_id: str) -> TrainingSession:
        session = self.repository.load_training_session(session_id)
        if session is None:
            raise ValueError("training session not found: {0}".format(session_id))
        return session
