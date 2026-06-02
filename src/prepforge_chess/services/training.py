from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Iterable, List, Optional, Tuple

from prepforge_chess.core.models import (
    MoveRecord,
    OpeningNode,
    Repertoire,
    TrainingMode,
    TrainingProgress,
    TrainingSession,
)
from prepforge_chess.services.progress import due_node_ids
from prepforge_chess.storage.repositories import PrepForgeRepository


@dataclass(frozen=True)
class TrainingLine:
    line_node_id: str
    node_ids: List[str]
    own_move_node_ids: List[str]
    san: str
    uci: str


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
    line_san: str
    remaining_mistakes: int


@dataclass(frozen=True)
class TrainingAttemptResult:
    correct: bool
    played_uci: str
    expected_uci: str
    expected_san: str
    completed_line: bool
    session: TrainingSession
    progress: TrainingProgress
    next_prompt: Optional[TrainingPrompt]
    # Intermediate positions so the UI can play the player's move and the
    # opponent's reply as two distinct, animated steps (set only when correct).
    played_san: Optional[str] = None
    fen_after_player: Optional[str] = None
    reply_uci: Optional[str] = None
    reply_san: Optional[str] = None
    fen_after_reply: Optional[str] = None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def create_training_session(
    *,
    repertoire_id: str,
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
        mode=mode,
        line_order=line_order,
        current_index=0,
        seed=actual_seed,
    )


def resume_or_create_session(
    *,
    existing: Optional[TrainingSession],
    repertoire_id: str,
    line_ids: Iterable[str],
    mode: TrainingMode,
    seed: Optional[int] = None,
) -> TrainingSession:
    if existing is not None:
        return existing
    return create_training_session(
        repertoire_id=repertoire_id,
        line_ids=line_ids,
        mode=mode,
        seed=seed,
    )


class TrainingService:
    def __init__(self, repository: PrepForgeRepository):
        self.repository = repository

    def start_or_resume_session(
        self,
        repertoire_id: str,
        *,
        mode: TrainingMode = TrainingMode.ALL_LINES,
        seed: Optional[int] = None,
    ) -> TrainingSession:
        existing = self.repository.load_latest_training_session(repertoire_id, mode)
        if existing is not None:
            repertoire = self._load_repertoire_or_raise(repertoire_id)
            intact = bool(existing.line_order) and all(
                self._find_node(repertoire.root_node, node_id) is not None
                for node_id in existing.line_order
            )
            complete = existing.current_index >= len(existing.line_order)
            if intact and not complete:
                return existing
            # Either the session finished (restart it) or the repertoire changed
            # under it (stale node ids) — rebuild a fresh run from the current
            # tree instead of returning an empty/broken session.
            line_ids = (
                existing.line_order
                if intact
                else [line.line_node_id for line in self.training_lines(repertoire, mode)]
            )
            refreshed = replace(
                existing,
                line_order=line_ids,
                current_index=0,
                current_node_id=None,
                updated_at=_utc_now(),
            )
            self.repository.save_training_session(refreshed)
            return refreshed

        repertoire = self._load_repertoire_or_raise(repertoire_id)
        line_ids = [line.line_node_id for line in self.training_lines(repertoire, mode)]
        session = create_training_session(
            repertoire_id=repertoire_id,
            line_ids=line_ids,
            mode=mode,
            seed=seed,
        )
        self.repository.save_training_session(session)
        return session

    def training_lines(
        self,
        repertoire: Repertoire,
        mode: TrainingMode = TrainingMode.ALL_LINES,
    ) -> List[TrainingLine]:
        all_lines = [
            self._line_from_path(path)
            for path in self._leaf_paths(repertoire.root_node)
            if self._own_move_nodes(path, repertoire)
        ]
        if mode is TrainingMode.HIGH_PRIORITY:
            filtered = [
                line
                for line in all_lines
                if self._path_has_priority(self._path_to_node(repertoire.root_node, line.line_node_id))
            ]
            return filtered or all_lines
        if mode is TrainingMode.MISTAKES_ONLY:
            # "Due review" = spaced-repetition due nodes ∪ the latest session's
            # open mistakes. Select whole leaf lines that pass through any such
            # node so the user replays them in context, not as isolated moves.
            target_ids = due_node_ids(self.repository.list_training_progress(repertoire.id))
            existing = self.repository.load_latest_training_session(repertoire.id)
            if existing is not None and existing.mistakes:
                target_ids |= set(existing.mistakes)
            if target_ids:
                due_lines = [
                    self._line_from_path(path)
                    for path in self._leaf_paths(repertoire.root_node)
                    if self._own_move_nodes(path, repertoire)
                    and any(node.id in target_ids for node in path)
                ]
                if due_lines:
                    return due_lines
        return all_lines

    def current_prompt(self, session_id: str) -> Optional[TrainingPrompt]:
        session = self._load_session_or_raise(session_id)
        repertoire = self._load_repertoire_or_raise(session.repertoire_id)
        return self._prompt_for_session(repertoire, session)

    def skip_current_line(self, session_id: str) -> Optional[TrainingPrompt]:
        session = self._load_session_or_raise(session_id)
        repertoire = self._load_repertoire_or_raise(session.repertoire_id)
        if session.current_index >= len(session.line_order):
            return None
        updated = replace(
            session,
            current_index=session.current_index + 1,
            current_node_id=None,
            updated_at=_utc_now(),
        )
        self.repository.save_training_session(updated)
        return self._prompt_for_session(repertoire, updated)

    def submit_move(self, session_id: str, played_uci: str) -> TrainingAttemptResult:
        session = self._load_session_or_raise(session_id)
        repertoire = self._load_repertoire_or_raise(session.repertoire_id)
        prompt = self._prompt_for_session(repertoire, session)
        if prompt is None:
            raise ValueError("training session has no current prompt")

        progress = self.repository.load_training_progress(
            repertoire.id,
            prompt.expected_node_id,
        ) or TrainingProgress(node_id=prompt.expected_node_id)
        correct = played_uci == prompt.expected_move_uci
        updated_session, updated_progress = record_attempt(
            session=session,
            progress=progress,
            node_id=prompt.expected_node_id,
            correct=correct,
        )

        completed_line = False
        if correct:
            next_expected = self._next_expected_node_after(
                repertoire,
                updated_session,
                prompt.expected_node_id,
            )
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

        self.repository.save_training_session(updated_session)
        self.repository.save_training_progress(repertoire.id, updated_progress)

        # Surface the player's move result and the opponent's single reply so
        # the UI can animate them as two separate steps instead of jumping the
        # board forward two plies at once.
        played_san = None
        fen_after_player = None
        reply_uci = reply_san = fen_after_reply = None
        if correct:
            played_node = self._find_node(repertoire.root_node, prompt.expected_node_id)
            if played_node is not None and played_node.move is not None:
                played_san = played_node.move.san
                fen_after_player = played_node.move.fen_after
            reply = self._reply_after(repertoire, updated_session, prompt.expected_node_id)
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
            next_prompt=self._prompt_for_session(repertoire, updated_session),
            played_san=played_san,
            fen_after_player=fen_after_player,
            reply_uci=reply_uci,
            reply_san=reply_san,
            fen_after_reply=fen_after_reply,
        )

    def _reply_after(
        self,
        repertoire: Repertoire,
        session: TrainingSession,
        played_node_id: str,
    ) -> Optional[OpeningNode]:
        """The opponent's reply node immediately following the player's move."""
        if session.current_index >= len(session.line_order):
            return None
        try:
            path = self._path_to_node(
                repertoire.root_node, session.line_order[session.current_index]
            )
        except ValueError:
            return None
        for index, node in enumerate(path):
            if node.id == played_node_id and index + 1 < len(path):
                return path[index + 1]
        return None

    def _prompt_for_session(
        self,
        repertoire: Repertoire,
        session: TrainingSession,
    ) -> Optional[TrainingPrompt]:
        if session.current_index >= len(session.line_order):
            return None

        line_node_id = session.line_order[session.current_index]
        path = self._path_to_node(repertoire.root_node, line_node_id)
        expected_nodes = self._own_move_nodes(path, repertoire)
        if not expected_nodes:
            return None

        by_id = {node.id: node for node in expected_nodes}
        expected = by_id.get(session.current_node_id or "") or expected_nodes[0]
        move = self._move_or_raise(expected)
        line = self._line_from_path(path)
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
            line_san=line.san,
            remaining_mistakes=len(session.mistakes),
        )

    def _next_expected_node_after(
        self,
        repertoire: Repertoire,
        session: TrainingSession,
        node_id: str,
    ) -> Optional[OpeningNode]:
        if session.current_index >= len(session.line_order):
            return None
        path = self._path_to_node(repertoire.root_node, session.line_order[session.current_index])
        expected_nodes = self._own_move_nodes(path, repertoire)
        for index, node in enumerate(expected_nodes):
            if node.id == node_id:
                if index + 1 < len(expected_nodes):
                    return expected_nodes[index + 1]
                return None
        return expected_nodes[0] if expected_nodes else None

    def _leaf_paths(self, root: OpeningNode) -> List[List[OpeningNode]]:
        paths: List[List[OpeningNode]] = []

        def visit(node: OpeningNode, path: List[OpeningNode]) -> None:
            enabled_children = [child for child in node.children if child.is_enabled]
            if not enabled_children:
                if path:
                    paths.append(path)
                return
            for child in enabled_children:
                visit(child, path + [child])

        visit(root, [])
        return paths

    def _line_from_path(self, path: List[OpeningNode]) -> TrainingLine:
        moves = [self._move_or_raise(node) for node in path if node.move is not None]
        own_ids = [node.id for node in path if node.move is not None and node.is_user_prepared_move]
        if not own_ids:
            own_ids = [node.id for node in path if node.move is not None]
        leaf = path[-1]
        return TrainingLine(
            line_node_id=leaf.id,
            node_ids=[node.id for node in path],
            own_move_node_ids=own_ids,
            san=" ".join(move.san for move in moves),
            uci=" ".join(move.uci for move in moves),
        )

    def _own_move_nodes(self, path: List[OpeningNode], repertoire: Repertoire) -> List[OpeningNode]:
        return [
            node
            for node in path
            if node.move is not None
            and node.move.side_to_move is repertoire.color
            and node.is_enabled
        ]

    def _path_has_priority(self, path: List[OpeningNode]) -> bool:
        return any(
            node.priority > 0
            or "critical" in node.tags
            or "high-priority" in node.tags
            or "tactical-warning" in node.tags
            for node in path
        )

    def _path_to_node(self, root: OpeningNode, node_id: str) -> List[OpeningNode]:
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

    def _find_node(self, root: OpeningNode, node_id: str) -> Optional[OpeningNode]:
        if root.id == node_id:
            return root
        for child in root.children:
            found = self._find_node(child, node_id)
            if found is not None:
                return found
        return None

    def _move_or_raise(self, node: OpeningNode) -> MoveRecord:
        if node.move is None:
            raise ValueError("opening node has no move: {0}".format(node.id))
        return node.move

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


def record_attempt(
    *,
    session: TrainingSession,
    progress: TrainingProgress,
    node_id: str,
    correct: bool,
    now: Optional[datetime] = None,
) -> Tuple[TrainingSession, TrainingProgress]:
    timestamp = now or _utc_now()

    mistakes = list(session.mistakes)
    mastered = list(session.mastered_nodes)

    if correct:
        if node_id in mistakes:
            mistakes.remove(node_id)
        if node_id not in mastered and progress.correct_attempts + 1 >= 3:
            mastered.append(node_id)
    else:
        if node_id not in mistakes:
            mistakes.append(node_id)

    updated_progress = update_spaced_repetition(progress, correct=correct, now=timestamp)
    updated_session = replace(
        session,
        mistakes=mistakes,
        mastered_nodes=mastered,
        current_node_id=node_id,
        updated_at=timestamp,
    )
    return updated_session, updated_progress


def update_spaced_repetition(
    progress: TrainingProgress,
    *,
    correct: bool,
    now: Optional[datetime] = None,
) -> TrainingProgress:
    timestamp = now or _utc_now()
    attempts = progress.attempts + 1
    correct_attempts = progress.correct_attempts + (1 if correct else 0)

    if correct:
        score = min(10.0, progress.spaced_repetition_score + 1.0)
        interval_days = max(1, int(round(score)))
        due_at = timestamp + timedelta(days=interval_days)
    else:
        score = max(0.0, progress.spaced_repetition_score * 0.5)
        due_at = timestamp + timedelta(minutes=10)

    return replace(
        progress,
        attempts=attempts,
        correct_attempts=correct_attempts,
        last_reviewed_at=timestamp,
        spaced_repetition_score=score,
        due_at=due_at,
        is_mastered=score >= 7.0 and correct_attempts >= 3,
    )
