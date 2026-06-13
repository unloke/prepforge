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
    DEFAULT_NEW_CAP,
    DEFAULT_SESSION_SIZE,
    RUN_IN_PLIES,
    SessionPlan,
    TrainingCard,
    build_session_plan,
    card_counts,
    decode_card,
    encode_card,
    mix_plans,
    own_move_nodes_on,
    path_to_node,
)
from prepforge_chess.services.training import record_attempt
from prepforge_chess.services.training_view import heuristic_strategy, piece_name_at
from prepforge_chess.storage.repositories import PrepForgeRepository

# A re-queued card comes back after this many other cards — soon enough that
# the position is still warm, far enough that it's recall rather than echo.
# The client-side scheduler (app.js submitSmartMove) mirrors this constant.
REQUEUE_GAP = 3

# Caps for the local-first sync flush (/api/train/smart/sync): an untrusted,
# no-compute write, fenced like opening_builder.MAX_ADD_MOVES_BATCH. A session
# queue caps at ~30 cards × ~3 targets, and requeues only ever re-insert
# existing cards, so legitimate batches sit far below these.
MAX_SYNC_ATTEMPTS = 500
MAX_SYNC_QUEUE = 500


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

    # --------------------------------------------------------- mixed sessions

    def active_repertoires(self, owner_user_id: str) -> List[Repertoire]:
        return [
            rep
            for rep in self.repository.list_repertoires(owner_user_id=owner_user_id)
            if getattr(rep, "is_active", True)
        ]

    def start_or_resume_mixed(
        self,
        owner_user_id: str,
        *,
        fresh: bool = False,
        session_size: Optional[int] = None,
        new_cap: Optional[int] = None,
        seed: Optional[int] = None,
    ) -> TrainingSession:
        """One smart session across ALL of the owner's active repertoires.

        The session row needs a real repertoire (FK), so it anchors on the
        active repertoire with the smallest id — stable across restarts — and
        mixedness lives in the cards themselves (4-part ``kind:rep:first:last``
        encoding). With a single active repertoire this simply delegates to the
        plain per-repertoire start."""
        reps = self.active_repertoires(owner_user_id)
        if not reps:
            raise ValueError("no active repertoires to train")
        if len(reps) == 1:
            return self.start_or_resume(
                reps[0].id,
                fresh=fresh,
                session_size=session_size,
                new_cap=new_cap,
                seed=seed,
            )
        anchor = min(reps, key=lambda rep: rep.id)
        existing = self.repository.load_latest_training_session(
            anchor.id, TrainingMode.SMART
        )
        if existing is not None and not fresh and self._resumable_mixed(existing, reps):
            return existing

        actual_seed = seed if seed is not None else random.SystemRandom().randint(1, 2**31 - 1)
        # Split the session budget across repertoires (ceil, so small counts
        # still get a slot); build_session_plan handles the per-rep urgency.
        total_size = session_size if session_size is not None else DEFAULT_SESSION_SIZE
        total_new = new_cap if new_cap is not None else DEFAULT_NEW_CAP
        per_size = max(2, -(-total_size // len(reps)))
        per_new = max(1, -(-total_new // len(reps)))
        plans: List[tuple[str, SessionPlan]] = []
        for index, rep in enumerate(reps):
            progress_by_id = {
                p.node_id: p for p in self.repository.list_training_progress(rep.id)
            }
            plans.append(
                (
                    rep.id,
                    build_session_plan(
                        rep.root_node,
                        rep.color,
                        progress_by_id,
                        seed=actual_seed + index,
                        session_size=per_size,
                        new_cap=per_new,
                    ),
                )
            )
        mixed = mix_plans(plans, seed=actual_seed)
        if not mixed.cards:
            raise ValueError("repertoires have no trainable moves yet")

        line_order = [encode_card(card) for card in mixed.cards]
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
                repertoire_id=anchor.id,
                mode=TrainingMode.SMART,
                line_order=line_order,
                current_index=0,
                seed=actual_seed,
            )
        self.repository.save_training_session(session)
        return session

    def _resumable_mixed(
        self, session: TrainingSession, reps: List[Repertoire]
    ) -> bool:
        if not session.line_order or session.current_index >= len(session.line_order):
            return False
        ids_by_rep: Dict[str, set] = {}
        for rep in reps:
            node_ids = set()
            stack = [rep.root_node]
            while stack:
                node = stack.pop()
                node_ids.add(node.id)
                stack.extend(node.children)
            ids_by_rep[rep.id] = node_ids
        for raw in session.line_order:
            card = decode_card(raw)
            # A 3-part card means this is a plain single-repertoire session
            # parked on the anchor — never resume it as a mixed one.
            if card is None or not card.repertoire_id:
                return False
            node_ids = ids_by_rep.get(card.repertoire_id)
            if (
                node_ids is None
                or card.first_target_id not in node_ids
                or card.last_target_id not in node_ids
            ):
                return False
        return True

    def _card_repertoire(
        self,
        session: TrainingSession,
        card: TrainingCard,
        cache: Dict[str, Optional[Repertoire]],
    ) -> Optional[Repertoire]:
        """Resolve the repertoire a card's targets live in. Foreign-repertoire
        cards (mixed sessions) are honoured only when that repertoire belongs
        to the SAME, NON-NULL owner as the session's anchor — a tampered synced
        queue must never read or write another user's data. Requiring a non-null
        owner is essential: ``None == None`` is truthy, so without it a legacy/
        unclaimed anchor could pull in any other unclaimed repertoire's tree."""
        rep_id = card.repertoire_id or session.repertoire_id
        if rep_id in cache:
            return cache[rep_id]
        rep: Optional[Repertoire] = None
        if rep_id == session.repertoire_id:
            rep = self.repository.load_repertoire(rep_id)
        else:
            anchor_meta = self.repository.repertoire_meta(session.repertoire_id)
            meta = self.repository.repertoire_meta(rep_id)
            if (
                anchor_meta is not None
                and meta is not None
                and anchor_meta["owner_user_id"] is not None
                and meta["owner_user_id"] == anchor_meta["owner_user_id"]
            ):
                rep = self.repository.load_repertoire(rep_id)
        cache[rep_id] = rep
        return rep

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
        persisting past) cards whose targets were edited away in Build.
        Mixed-session cards carry their own repertoire id and resolve against
        THAT tree; ``repertoire`` (the session's anchor) seeds the cache."""
        cache: Dict[str, Optional[Repertoire]] = {repertoire.id: repertoire}
        while session.current_index < len(session.line_order):
            card = decode_card(session.line_order[session.current_index])
            context = None
            if card is not None:
                card_rep = self._card_repertoire(session, card, cache)
                if card_rep is not None:
                    context = self._card_context(session, card_rep, card)
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
            repertoire_id=context.repertoire.id,
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

    # ----------------------------------------------------------------- bundle

    def session_card_bundle(
        self, session: TrainingSession, repertoire: Repertoire
    ) -> List[dict]:
        """Expand the session's queue into self-contained card data so the
        client can run the whole session locally (local-first Train): per
        target — the expected move, the run-in to animate, the hint texts and
        the opponent reply. Cards whose targets were edited away in Build are
        skipped, mirroring ``_context``'s stale-card skip. Every card names its
        repertoire (id/name/colour) so the client can flip the board and label
        the position per card in mixed sessions."""
        cards: List[dict] = []
        cache: Dict[str, Optional[Repertoire]] = {repertoire.id: repertoire}
        for raw in session.line_order:
            card = decode_card(raw)
            if card is None:
                continue
            card_rep = self._card_repertoire(session, card, cache)
            if card_rep is None:
                continue
            try:
                path = path_to_node(card_rep.root_node, card.last_target_id)
            except ValueError:
                continue
            own = own_move_nodes_on(path, card_rep.color)
            first_index = next(
                (i for i, node in enumerate(own) if node.id == card.first_target_id),
                None,
            )
            if first_index is None:
                continue
            targets = []
            for node in own[first_index:]:
                move = node.move
                if move is None:
                    continue
                path_pos = next(i for i, p in enumerate(path) if p.id == node.id)
                run_in = [
                    p
                    for p in path[max(0, path_pos - RUN_IN_PLIES) : path_pos]
                    if p.move is not None
                ]
                piece = piece_name_at(move.fen_before, move.uci)
                annotation = (
                    node.strategic_idea or node.typical_plan or (node.comment or "")
                ).strip()
                reply = self._reply_after(path, node)
                targets.append(
                    {
                        "node_id": node.id,
                        "uci": move.uci,
                        "san": move.san,
                        "fen_before": move.fen_before,
                        "fen_after": move.fen_after,
                        "start_fen": run_in[0].move.fen_before if run_in else move.fen_before,
                        "run_in": [
                            {"uci": p.move.uci, "san": p.move.san} for p in run_in
                        ],
                        "hint": {
                            "strategy": annotation
                            or heuristic_strategy(move.san, piece),
                            "piece": "Move the {0}".format(piece)
                            if piece
                            else "Find the move",
                            "annotated": bool(annotation),
                        },
                        "reply": None
                        if reply is None or reply.move is None
                        else {
                            "uci": reply.move.uci,
                            "san": reply.move.san,
                            "fen_after": reply.move.fen_after,
                        },
                    }
                )
            if targets:
                cards.append(
                    {
                        "kind": card.kind,
                        "encoded": raw,
                        "repertoire_id": card_rep.id,
                        "repertoire_name": card_rep.name,
                        "color": card_rep.color.value,
                        "targets": targets,
                    }
                )
        return cards

    # ------------------------------------------------------------------- sync

    def sync_progress(
        self,
        session_id: str,
        attempts: List[dict],
        *,
        card_index: Optional[int] = None,
        queue: Optional[List[str]] = None,
    ) -> int:
        """Persist a batch of locally graded first attempts plus the session's
        position — the local-first Train flush. Replays each attempt through
        ``record_attempt`` in order, so the stored spaced-repetition state is
        identical to what the same moves would have written one-by-one via
        ``submit_move``. Attempts on nodes edited out of the tree are skipped
        with a light clamp, not an error. Returns how many attempts landed.

        Trust note (docs/local-first-sync-plan.md §2.2): the client grades its
        own answers, so a tampered client can fake its own SR progress — that
        only distorts that user's own training queue, an accepted trade-off.
        """
        if len(attempts) > MAX_SYNC_ATTEMPTS:
            raise ValueError(
                "too many attempts in batch ({0} > {1})".format(
                    len(attempts), MAX_SYNC_ATTEMPTS
                )
            )
        session = self._load_session_or_raise(session_id)
        repertoire = self._load_repertoire_or_raise(session.repertoire_id)
        # Map node id -> owning repertoire across every repertoire the queue
        # references (mixed sessions span several; ownership is enforced by
        # _card_repertoire, so a tampered queue can't pull in foreign trees).
        cache: Dict[str, Optional[Repertoire]] = {repertoire.id: repertoire}
        rep_of_node: Dict[str, str] = {}

        def _index(rep: Repertoire) -> None:
            stack = [rep.root_node]
            while stack:
                node = stack.pop()
                rep_of_node.setdefault(node.id, rep.id)
                stack.extend(node.children)

        _index(repertoire)
        for raw in session.line_order:
            card = decode_card(raw)
            if card is None or not card.repertoire_id or card.repertoire_id in cache:
                continue
            card_rep = self._card_repertoire(session, card, cache)
            if card_rep is not None:
                _index(card_rep)

        written = 0
        for item in attempts:
            node_id = item.get("node_id")
            rep_id = rep_of_node.get(node_id)
            if rep_id is None:
                continue
            stored = self.repository.load_training_progress(
                rep_id, node_id
            ) or TrainingProgress(node_id=node_id)
            session, progress = record_attempt(
                session=session,
                progress=stored,
                node_id=node_id,
                correct=bool(item.get("correct")),
            )
            self.repository.save_training_progress(rep_id, progress)
            written += 1

        if queue is not None:
            if len(queue) > MAX_SYNC_QUEUE:
                raise ValueError(
                    "queue too long ({0} > {1})".format(len(queue), MAX_SYNC_QUEUE)
                )
            # Only well-formed encoded cards land; a malformed entry is dropped
            # rather than poisoning the stored session.
            cleaned = [raw for raw in queue if decode_card(raw) is not None]
            session = replace(session, line_order=cleaned)
        if card_index is not None:
            clamped = max(0, min(int(card_index), len(session.line_order)))
            session = replace(session, current_index=clamped, current_node_id=None)
        session = replace(session, updated_at=_utc_now())
        self.repository.save_training_session(session)
        return written

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
        card_rep = context.repertoire  # the card's own repertoire (mixed sessions)
        expected = context.expected
        move = expected.move
        correct = played_uci == move.uci

        progress: Optional[TrainingProgress] = None
        sr_written = attempt <= 1
        if sr_written:
            stored = self.repository.load_training_progress(
                card_rep.id, expected.id
            ) or TrainingProgress(node_id=expected.id)
            session, progress = record_attempt(
                session=session,
                progress=stored,
                node_id=expected.id,
                correct=correct,
            )
            self.repository.save_training_progress(card_rep.id, progress)

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
            reply = self._reply_after(context.path, expected)
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
        self, path: List[OpeningNode], expected: OpeningNode
    ) -> Optional[OpeningNode]:
        """The opponent move the client animates after a correct answer: the
        next node on the card's path, or — past the last target — the first
        enabled child, so even a card's final move gets its "it worked" beat."""
        for index, node in enumerate(path):
            if node.id == expected.id:
                if index + 1 < len(path):
                    return path[index + 1]
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
