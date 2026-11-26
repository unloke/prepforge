from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from prepforge_chess.core.models import (
    MoveRecord,
    OpeningNode,
    Repertoire,
    TrainingMode,
    TrainingProgress,
    TrainingSession,
)
from prepforge_chess.services.scheduler import (
    index_nodes,
    own_move_nodes_on,
    path_to_node,
    sibling_moves,
    target_run_in,
)
from prepforge_chess.services.srs import rating_for, review
from prepforge_chess.services.training_hints import node_annotation
from prepforge_chess.storage.codec import hydrate_opening_paths
from prepforge_chess.storage.ports import TrainerStore, TrainingStore


@dataclass(frozen=True)
class TrainingPrompt:
    session_id: str
    repertoire_id: str
    line_node_id: str
    current_index: int
    total_lines: int
    expected_node_id: str
    expected_move_uci: str
    expected_move_san: str
    fen_before: str
    remaining_mistakes: int
    # The prompt's place among the line's asked moves (0 = the line starts) and
    # the moves the client plays before asking, from ``start_fen``.
    target_index: int = 0
    start_fen: str = ""
    run_in: Tuple[OpeningNode, ...] = ()
    annotation: str = ""


@dataclass(frozen=True)
class TrainingAttemptResult:
    correct: bool
    played_uci: str
    expected_uci: str
    expected_san: str
    completed_line: bool
    session: TrainingSession
    progress: Optional[TrainingProgress]  # None for an ungraded retry
    next_prompt: Optional[TrainingPrompt]
    # Intermediate positions so the UI can play the player's move and the
    # opponent's reply as two distinct, animated steps (set only when correct).
    played_san: Optional[str] = None
    fen_after_player: Optional[str] = None
    reply_uci: Optional[str] = None
    reply_san: Optional[str] = None
    fen_after_reply: Optional[str] = None
    # The move is another repertoire move at this position: not graded, not a
    # miss; the prompt stays and the player tries again for the drilled move.
    alternative: bool = False


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def create_training_session(
    *,
    repertoire_id: str,
    owner_user_id: str,
    line_ids: Iterable[str],
    mode: TrainingMode,
    seed: Optional[int] = None,
) -> TrainingSession:
    line_order = list(line_ids)
    actual_seed = seed if seed is not None else random.SystemRandom().randint(1, 2**31 - 1)
    rng = random.Random(actual_seed)
    rng.shuffle(line_order)

    return TrainingSession(
        id=str(uuid.uuid4()),
        repertoire_id=repertoire_id,
        owner_user_id=owner_user_id,
        mode=mode,
        line_order=line_order,
        current_index=0,
        seed=actual_seed,
    )


class TrainingService:
    """Line rehearsal: every line in a shuffled order, played from move 1.

    Each own move is asked once per run, on the first line in the order that
    reaches it; later lines play it themselves on the way to their new moves,
    and a line that brings no new own move is dropped from the run. Skipping a
    line therefore skips its new moves too. The tree loads unhydrated and only
    the lines a response shows get SAN/FEN."""

    def __init__(self, repository: TrainerStore, owner_user_id: str | None = None):
        self.repository = repository
        self.owner_user_id = owner_user_id

    def start_or_resume_session(
        self,
        repertoire_id: str,
        *,
        mode: TrainingMode = TrainingMode.ALL_LINES,
        seed: Optional[int] = None,
        fresh: bool = False,
    ) -> TrainingSession:
        existing = self.repository.load_latest_training_session(repertoire_id, self._owner_or_raise(), mode)
        tree = self._load(repertoire_id)
        if existing is not None:
            intact = bool(existing.line_order) and all(
                node_id in tree.index for node_id in existing.line_order
            )
            complete = existing.current_index >= len(existing.line_order)
            if intact and not complete and not fresh:
                line_order = tree.trim(existing.line_order, existing.current_index)
                if line_order == existing.line_order:
                    return existing
                resumed = replace(existing, line_order=line_order, updated_at=_utc_now())
                self.repository.save_training_session(resumed)
                return resumed
            # Either the session finished (restart it) or the repertoire changed
            # under it (stale node ids) — rebuild a fresh run from the current
            # tree instead of returning an empty/broken session.
            line_ids = existing.line_order if intact else tree.line_ids()
            refreshed = replace(
                existing,
                line_order=tree.trim(line_ids),
                current_index=0,
                current_node_id=None,
                updated_at=_utc_now(),
            )
            self.repository.save_training_session(refreshed)
            return refreshed

        session = create_training_session(
            repertoire_id=repertoire_id,
            owner_user_id=self._owner_or_raise(),
            line_ids=tree.line_ids(),
            mode=mode,
            seed=seed,
        )
        session = replace(session, line_order=tree.trim(session.line_order))
        self.repository.save_training_session(session)
        return session

    def current_prompt(self, session_id: str, *, skip: bool = False) -> Optional[TrainingPrompt]:
        """The session's current prompt; ``skip`` first moves past the current line."""
        session = self._load_session_or_raise(session_id)
        tree = self._load(session.repertoire_id)
        if skip:
            if session.current_index >= len(session.line_order):
                return None
            session = replace(
                session, current_index=session.current_index + 1, current_node_id=None,
                updated_at=_utc_now(),
            )
            self.repository.save_training_session(session)
        return tree.prompt(session)

    def skip_current_line(self, session_id: str) -> Optional[TrainingPrompt]:
        return self.current_prompt(session_id, skip=True)

    def submit_move(
        self, session_id: str, played_uci: str, *, hinted: bool = False, attempt: int = 1
    ) -> TrainingAttemptResult:
        """Grade a move. A correct move after a hint advances the line and
        grades Hard: recalled, with help. Only the first attempt at a prompt
        is graded (same rule as the smart queue); a retry only moves on."""
        with self.repository.engine.begin() as conn:
            session = self.repository.lock_training_session(conn, session_id=session_id)
            if session is None:
                raise ValueError("training session not found")
            tree = self._load(session.repertoire_id, conn=conn)
            prompt = tree.prompt(session)
            if prompt is None:
                raise ValueError("training session has no current prompt")

            correct = played_uci == prompt.expected_move_uci
            if not correct:
                alternative = tree.alternative(session, prompt.expected_node_id, played_uci)
                if alternative is not None:
                    return TrainingAttemptResult(
                        correct=False,
                        played_uci=played_uci,
                        expected_uci=prompt.expected_move_uci,
                        expected_san=prompt.expected_move_san,
                        completed_line=False,
                        session=session,
                        progress=None,
                        next_prompt=prompt,
                        played_san=alternative.move.san,
                        fen_after_player=alternative.move.fen_after,
                        alternative=True,
                    )
            updated_session, updated_progress = session, None
            if attempt <= 1:
                updated_session, updated_progress = grade_attempt(
                    self.repository, conn, session, tree.repertoire.id, prompt.expected_node_id,
                    correct=correct, hinted=hinted, owner_user_id=self._owner_or_raise(),
                )

            completed_line = False
            if correct:
                next_expected = tree.next_asked(updated_session, prompt.expected_node_id)
                if next_expected is None:
                    completed_line = True
                    updated_session = replace(
                        updated_session,
                        current_index=min(
                            updated_session.current_index + 1,
                            len(updated_session.line_order),
                        ),
                        current_node_id=None,
                        updated_at=_utc_now(),
                    )
                else:
                    updated_session = replace(
                        updated_session,
                        current_node_id=next_expected.id,
                        updated_at=_utc_now(),
                    )
            else:
                updated_session = replace(
                    updated_session,
                    current_node_id=prompt.expected_node_id,
                    updated_at=_utc_now(),
                )

            self.repository.write_training_session(conn, updated_session)

        # Surface the player's move result and the opponent's single reply so
        # the UI can animate them as two separate steps instead of jumping the
        # board forward two plies at once.
        played_san = None
        fen_after_player = None
        reply_uci = reply_san = fen_after_reply = None
        if correct:
            played_node = tree.index.get(prompt.expected_node_id)
            if played_node is not None and played_node.move is not None:
                played_san = played_node.move.san
                fen_after_player = played_node.move.fen_after
            reply = tree.reply_after(session, prompt.expected_node_id)
            if reply is not None and reply.move is not None:
                reply_uci = reply.move.uci
                reply_san = reply.move.san
                fen_after_reply = reply.move.fen_after

        return TrainingAttemptResult(
            correct=correct,
            played_uci=played_uci,
            expected_uci=prompt.expected_move_uci,
            expected_san=prompt.expected_move_san,
            completed_line=completed_line,
            session=updated_session,
            progress=updated_progress,
            next_prompt=tree.prompt(updated_session),
            played_san=played_san,
            fen_after_player=fen_after_player,
            reply_uci=reply_uci,
            reply_san=reply_san,
            fen_after_reply=fen_after_reply,
        )

    def _load(self, repertoire_id: str, *, conn=None) -> "_RehearsalTree":
        repertoire = self.repository.load_repertoire(repertoire_id, conn=conn, hydrate=False)
        if repertoire is None:
            raise ValueError("repertoire not found: {0}".format(repertoire_id))
        return _RehearsalTree(repertoire, index_nodes(repertoire.root_node))

    def _load_session_or_raise(self, session_id: str) -> TrainingSession:
        session = self.repository.load_training_session(session_id)
        if session is None:
            raise ValueError("training session not found: {0}".format(session_id))
        return session

    def _owner_or_raise(self) -> str:
        if not self.owner_user_id:
            raise ValueError("training service requires an owner")
        return self.owner_user_id


@dataclass
class _RehearsalTree:
    """One request's structural tree plus its node index."""

    repertoire: Repertoire
    index: Dict[str, OpeningNode]

    def line_ids(self) -> List[str]:
        """Leaf ids of every enabled line that holds an own move, in tree order."""
        out: List[str] = []
        color = self.repertoire.color

        def visit(node: OpeningNode, has_own: bool) -> None:
            enabled = [child for child in node.children if child.is_enabled]
            if not enabled:
                if has_own and node is not self.repertoire.root_node:
                    out.append(node.id)
                return
            for child in enabled:
                own = child.move is not None and child.move.side_to_move is color
                visit(child, has_own or own)

        visit(self.repertoire.root_node, False)
        return out

    def path(self, line_id: str) -> List[OpeningNode]:
        return path_to_node(self.repertoire.root_node, line_id, index=self.index)

    def own_ids(self, line_id: str) -> List[str]:
        try:
            path = self.path(line_id)
        except ValueError:
            return []
        return [node.id for node in own_move_nodes_on(path, self.repertoire.color)]

    def trim(self, line_order: Sequence[str], start: int = 0) -> List[str]:
        """Drop the lines from ``start`` on that ask no own move an earlier line
        has not already asked."""
        seen = {node_id for line_id in line_order[:start] for node_id in self.own_ids(line_id)}
        kept = list(line_order[:start])
        for line_id in line_order[start:]:
            own = self.own_ids(line_id)
            if not seen.issuperset(own):
                kept.append(line_id)
                seen.update(own)
        return kept

    def asked(self, session: TrainingSession, path: List[OpeningNode]) -> List[OpeningNode]:
        """The line's own moves no earlier line in the run reaches."""
        covered = {
            node_id
            for line_id in session.line_order[: session.current_index]
            for node_id in self.own_ids(line_id)
        }
        return [node for node in own_move_nodes_on(path, self.repertoire.color) if node.id not in covered]

    def prompt(self, session: TrainingSession) -> Optional[TrainingPrompt]:
        if session.current_index >= len(session.line_order):
            return None
        line_node_id = session.line_order[session.current_index]
        path = self.path(line_node_id)
        expected_nodes = self.asked(session, path)
        if not expected_nodes:
            return None
        hydrate_opening_paths(self.repertoire.root_node, [line_node_id])
        by_id = {node.id: node for node in expected_nodes}
        expected = by_id.get(session.current_node_id or "") or expected_nodes[0]
        target_index = expected_nodes.index(expected)
        run_in = target_run_in(path, expected_nodes, target_index)
        move = _move_or_raise(expected)
        return TrainingPrompt(
            session_id=session.id,
            repertoire_id=session.repertoire_id,
            line_node_id=line_node_id,
            current_index=session.current_index,
            total_lines=len(session.line_order),
            expected_node_id=expected.id,
            expected_move_uci=move.uci,
            expected_move_san=move.san,
            fen_before=move.fen_before,
            remaining_mistakes=len(session.mistakes),
            target_index=target_index,
            start_fen=run_in[0].move.fen_before if run_in else move.fen_before,
            run_in=tuple(run_in),
            annotation=node_annotation(expected),
        )

    def alternative(
        self, session: TrainingSession, expected_node_id: str, played_uci: str
    ) -> Optional[OpeningNode]:
        path = self.path(session.line_order[session.current_index])
        expected = next((node for node in path if node.id == expected_node_id), None)
        if expected is None:
            return None
        other = next(
            (node for node in sibling_moves(self.repertoire.root_node, path, expected)
             if node.move.uci == played_uci),
            None,
        )
        if other is not None:
            hydrate_opening_paths(self.repertoire.root_node, [other.id])
        return other

    def reply_after(self, session: TrainingSession, played_node_id: str) -> Optional[OpeningNode]:
        """The opponent's reply right after the player's move on the session's line."""
        if session.current_index >= len(session.line_order):
            return None
        try:
            path = self.path(session.line_order[session.current_index])
        except ValueError:
            return None
        for index, node in enumerate(path):
            if node.id == played_node_id and index + 1 < len(path):
                return path[index + 1]
        return None

    def next_asked(self, session: TrainingSession, node_id: str) -> Optional[OpeningNode]:
        if session.current_index >= len(session.line_order):
            return None
        expected_nodes = self.asked(session, self.path(session.line_order[session.current_index]))
        for index, node in enumerate(expected_nodes):
            if node.id == node_id:
                return expected_nodes[index + 1] if index + 1 < len(expected_nodes) else None
        return expected_nodes[0] if expected_nodes else None


def _move_or_raise(node: OpeningNode) -> MoveRecord:
    if node.move is None:
        raise ValueError("opening node has no move: {0}".format(node.id))
    return node.move


def grade_attempt(
    repository: TrainingStore,
    conn,
    session: TrainingSession,
    repertoire_id: str,
    node_id: str,
    *,
    correct: bool,
    hinted: bool,
    owner_user_id: Optional[str],
) -> Tuple[TrainingSession, TrainingProgress]:
    """Grade a first attempt inside ``conn``'s transaction: read-modify-write the
    progress row under its lock (so a concurrent attempt on the same node is
    never lost to a stale snapshot) and log the review."""
    stored = repository.lock_training_progress(
        conn, repertoire_id=repertoire_id, node_id=node_id, owner_user_id=owner_user_id
    )
    session, progress = record_attempt(
        session=session, progress=stored, node_id=node_id, correct=correct, hinted=hinted
    )
    repository.write_training_progress(
        conn, repertoire_id=repertoire_id, progress=progress, owner_user_id=owner_user_id
    )
    repository.write_review(
        conn, owner_user_id=owner_user_id, node_id=node_id,
        rating=rating_for(correct, hinted=hinted), reviewed_at=progress.last_reviewed_at,
    )
    return session, progress


def record_attempt(
    *,
    session: TrainingSession,
    progress: TrainingProgress,
    node_id: str,
    correct: bool,
    hinted: bool = False,
    now: Optional[datetime] = None,
) -> Tuple[TrainingSession, TrainingProgress]:
    timestamp = now or _utc_now()
    recalled = correct and not hinted

    mistakes = list(session.mistakes)
    mastered = list(session.mastered_nodes)

    if correct:
        if node_id in mistakes:
            mistakes.remove(node_id)
        if recalled and node_id not in mastered and progress.correct_attempts + 1 >= 3:
            mastered.append(node_id)
    else:
        if node_id not in mistakes:
            mistakes.append(node_id)

    updated_progress = review(progress, rating_for(correct, hinted=hinted), now=timestamp)
    updated_session = replace(
        session,
        mistakes=mistakes,
        mastered_nodes=mastered,
        current_node_id=node_id,
        updated_at=timestamp,
    )
    return updated_session, updated_progress
