"""Training persistence."""
from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Dict, List, Mapping, Optional
from sqlalchemy import or_, and_, case, func, literal, select, update
from sqlalchemy.engine import Connection
from prepforge_chess.core.models import TrainingMode, TrainingProgress, TrainingSession
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.common import _bool_to_int, _insert, _int_to_bool, _json_dump, _json_load, _upsert
from prepforge_chess.storage.repositories.settings import SettingsRepository
from prepforge_chess.storage.repositories.settings import PLAYED_SESSIONS_KEY


_PROGRESS_COLUMNS = tuple(c for c in t.training_progress.c if c.name not in {"created_at", "updated_at"})


class TrainingRepository(SettingsRepository):
    def due_counts_by_repertoire(
        self, owner_user_id: str, *, now: Optional[datetime] = None
    ) -> Dict[str, int]:
        return {rep_id: counts["due"] for rep_id, counts in
                self.mastery_counts_by_repertoire(owner_user_id, now=now).items()}

    def due_windows_by_repertoire(self, owner_user_id: str, *, now: datetime, until: datetime) -> Dict[str, Dict[str, int]]:
        return self._progress_counts_by_repertoire(owner_user_id, now=now, due_until=until)

    def mastery_counts_by_repertoire(
        self, owner_user_id: str, *, now: Optional[datetime] = None,
        conn: Optional[Connection] = None,
    ) -> Dict[str, Dict[str, int]]:
        return self._progress_counts_by_repertoire(owner_user_id, now=now, conn=conn)

    def _progress_counts_by_repertoire(
        self, owner_user_id: str, *, now: Optional[datetime] = None,
        conn: Optional[Connection] = None, due_until: Optional[datetime] = None,
    ) -> Dict[str, Dict[str, int]]:
        """All exclusive mastery buckets in one owner-scoped statement/snapshot.

        Match node_mastery precedence over reachable own-side nodes. Only static
        tree coverage (shallow_lines) remains cached in the listing.
        """
        from prepforge_chess.core.sr_config import SR_CONFIG

        tp = t.training_progress
        nodes = t.opening_nodes
        now = now or datetime.now(timezone.utc)
        # The walk is scoped to THIS owner's repertoires. The outer query already
        # scopes progress to owner_user_id and node ids are globally unique, so the
        # scope cannot change the counts — it only keeps the recursion off
        # every other tenant's trees (the Library listing runs this per owner).
        owner_reps = select(t.repertoires.c.id).where(
            t.repertoires.c.owner_user_id == owner_user_id
        )
        # blocked = 1 once a DISABLED ancestor is on the path (the node's own
        # disabled flag is checked separately below, matching _is_trainable).
        blocked = (
            select(nodes.c.id.label("id"), nodes.c.repertoire_id, literal(0).label("blocked"))
            .where(nodes.c.parent_id.is_(None))
            .where(nodes.c.repertoire_id.in_(owner_reps))
            .cte("effective_nodes", recursive=True)
        )
        blocked = blocked.union_all(
            select(
                nodes.c.id,
                nodes.c.repertoire_id,
                case(
                    (blocked.c.blocked > 0, literal(1)),
                    (nodes.c.is_enabled == 0, literal(1)),
                    else_=literal(0),
                ),
            )
            .where(nodes.c.parent_id == blocked.c.id)
            # Carry ownership down the tree and use both columns of the existing
            # (repertoire_id, parent_id) index instead of scanning a repertoire
            # for each parent in the recursive step.
            .where(nodes.c.repertoire_id == blocked.c.repertoire_id)
        )
        # weak, in SQL: attempts >= 2 and lifetime accuracy below half and the
        # recent-form score still low. correct*2 < attempts avoids the
        # integer/float division difference between SQLite and Postgres.
        is_weak = and_(
            tp.c.attempts >= 2,
            tp.c.correct_attempts * 2 < tp.c.attempts,
            tp.c.spaced_repetition_score < SR_CONFIG.weak_score_below,
        )
        def state_at(deadline):
            return case(
                (or_(tp.c.attempts.is_(None), tp.c.attempts <= 0), "untrained"),
                (is_weak, "weak"),
                (tp.c.due_at <= deadline, "due"),
                (or_(tp.c.is_mastered == 1, tp.c.spaced_repetition_score >= SR_CONFIG.mastered_score_at), "mastered"),
                else_="learning",
            )

        state = state_at(now)
        states = ("mastered", "learning", "due", "weak", "untrained")
        aggregates = [func.sum(case((state == name, 1), else_=0)).label(name) for name in states]
        if due_until is not None:
            aggregates = [
                func.sum(case((state == "due", 1), else_=0)).label("due"),
                func.sum(case((state_at(due_until) == "due", 1), else_=0)).label("due_until"),
            ]
        stmt = (
            select(nodes.c.repertoire_id, *aggregates)
            .select_from(nodes.join(blocked, blocked.c.id == nodes.c.id).outerjoin(
                tp, and_(tp.c.node_id == nodes.c.id, tp.c.repertoire_id == nodes.c.repertoire_id,
                         tp.c.owner_user_id == owner_user_id)
            ))
            .where(blocked.c.blocked == 0)
            .where(nodes.c.is_enabled == 1)
            .where(nodes.c.is_user_prepared_move == 1)
            .where(nodes.c.uci.is_not(None))
            .group_by(nodes.c.repertoire_id)
        )
        with nullcontext(conn) if conn is not None else self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        if due_until is not None:
            return {row["repertoire_id"]: {"due": int(row["due"]), "due_until": int(row["due_until"])} for row in rows}
        out = {}
        for row in rows:
            counts = {name: int(row[name]) for name in states}
            counts["trainable"] = sum(counts.values())
            counts["mastery_pct"] = (round(counts["mastered"] / counts["trainable"] * 100)
                                     if counts["trainable"] else 0)
            out[row["repertoire_id"]] = counts
        return out

    def iter_owner_training_progress(self, owner_user_id: str):
        """Raw progress rows across all repertoires (account export, F-05)."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(*_PROGRESS_COLUMNS).where(
                    t.training_progress.c.owner_user_id == owner_user_id
                )
             .execution_options(yield_per=100)).mappings()
            for row in rows:
                yield {
                    "repertoire_id": row["repertoire_id"],
                    "node_id": row["node_id"],
                    "attempts": row["attempts"],
                    "correct_attempts": row["correct_attempts"],
                    "last_reviewed_at": row["last_reviewed_at"],
                    "spaced_repetition_score": row["spaced_repetition_score"],
                    "due_at": row["due_at"],
                    "is_mastered": _int_to_bool(row["is_mastered"]),
                }

    def iter_owner_training_sessions(self, owner_user_id: str):
        """Session summaries across the owner's repertoires (account export, F-05)."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(t.training_sessions)
                .join(
                    t.repertoires,
                    t.repertoires.c.id == t.training_sessions.c.repertoire_id,
                )
                .where(t.repertoires.c.owner_user_id == owner_user_id)
             .execution_options(yield_per=100)).mappings()
            for row in rows:
                yield {
                    "id": row["id"],
                    "repertoire_id": row["repertoire_id"],
                    "mode": row["mode"],
                    "current_index": row["current_index"],
                    "mistakes": _json_load(row["mistakes_json"], []),
                    "mastered_nodes": _json_load(row["mastered_nodes_json"], []),
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }

    def restart_training_session(self, session: TrainingSession, owner: str | None) -> None:
        """Count a replaced played generation and install its successor atomically.

        Reread under a row lock: overlapping Starts must not both count the same
        generation. A partially answered first card has a current_node_id even
        though current_index is still zero.
        """
        with self.engine.begin() as conn:
            existing = self.lock_training_session(conn, session_id=session.id)
            if owner and existing and (
                existing.current_index > 0 or existing.current_node_id
                or existing.mistakes or existing.mastered_nodes
            ):
                cur = self.lock_user_setting(conn, owner, PLAYED_SESSIONS_KEY, 0)
                count = cur if isinstance(cur, int) and cur >= 0 else 0
                self.write_user_setting(conn, owner, PLAYED_SESSIONS_KEY, count + 1)
            self.write_training_session(conn, session)

    def save_training_session(self, session: TrainingSession) -> None:
        with self.engine.begin() as conn:
            self.write_training_session(conn, session)

    def write_training_session(self, conn: Connection, session: TrainingSession) -> None:
        """Conn-scoped ``save_training_session``: run inside the caller's
        transaction so the session write commits together with related writes
        (attempt receipts, progress rows)."""
        values = {
                "id": session.id,
                "repertoire_id": session.repertoire_id,
                "mode": session.mode.value,
                "line_order_json": _json_dump(session.line_order),
                "current_index": session.current_index,
                "current_node_id": session.current_node_id,
                "mistakes_json": _json_dump(session.mistakes),
                "mastered_nodes_json": _json_dump(session.mastered_nodes),
                "seed": session.seed,
                "created_at": session.created_at,
                "updated_at": session.updated_at,
                "state_version": 1,
        }
        stmt = _insert(conn, t.training_sessions).values(values)
        updates = {key: stmt.excluded[key] for key in values if key not in {"id", "state_version"}}
        updates["state_version"] = t.training_sessions.c.state_version + 1
        stmt = stmt.on_conflict_do_update(index_elements=["id"], set_=updates)
        session.state_version = conn.execute(
            stmt.returning(t.training_sessions.c.state_version)
        ).scalar_one()

    def load_training_session(self, session_id: str) -> Optional[TrainingSession]:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.training_sessions).where(t.training_sessions.c.id == session_id)
            ).mappings().first()
        return self._training_session_from_row(row) if row is not None else None

    def load_latest_training_session(
        self,
        repertoire_id: str,
        mode: Optional[TrainingMode] = None,
    ) -> Optional[TrainingSession]:
        stmt = (
            select(t.training_sessions)
            .where(t.training_sessions.c.repertoire_id == repertoire_id)
            .order_by(t.training_sessions.c.updated_at.desc())
            .limit(1)
        )
        if mode is not None:
            stmt = stmt.where(t.training_sessions.c.mode == mode.value)
        with self.engine.connect() as conn:
            row = conn.execute(stmt).mappings().first()
        return self._training_session_from_row(row) if row is not None else None

    def lock_training_session(
        self,
        conn: Connection,
        *,
        session_id: str,
    ) -> Optional[TrainingSession]:
        """Read-modify-write handle on one session row inside an open transaction.

        Reads the row FOR UPDATE so concurrent updaters of the same session
        serialise here (PostgreSQL) and each computes from the other's committed
        state instead of a pre-transaction snapshot — a full-row upsert built
        from a stale snapshot silently clobbers the other sync's mistakes,
        mastered nodes, and position. Follow up with ``write_training_session``
        before the transaction ends. Returns None when the row is absent."""
        # SQLite has no FOR UPDATE. Acquire its writer lock before reading the
        # session so file-backed concurrent requests cannot use stale state.
        if conn.dialect.name == "sqlite":
            conn.execute(update(t.training_sessions).where(
                t.training_sessions.c.id == session_id
            ).values(state_version=t.training_sessions.c.state_version))
        row = (
            conn.execute(
                select(t.training_sessions)
                .where(t.training_sessions.c.id == session_id)
                .with_for_update()
            )
            .mappings()
            .first()
        )
        return self._training_session_from_row(row) if row is not None else None

    def save_training_progress(
        self,
        repertoire_id: str,
        progress: TrainingProgress,
        *,
        owner_user_id: str,
    ) -> None:
        with self.engine.begin() as conn:
            self.write_training_progress(
                conn,
                repertoire_id=repertoire_id,
                progress=progress,
                owner_user_id=owner_user_id,
            )

    def write_training_progress(
        self,
        conn: Connection,
        *,
        repertoire_id: str,
        progress: TrainingProgress,
        owner_user_id: str,
    ) -> None:
        """Conn-scoped ``save_training_progress``: run inside the caller's
        transaction so the progress write commits together with related writes
        (attempt receipts, ingest ledgers)."""
        progress_id = self._training_progress_id(owner_user_id, repertoire_id, progress.node_id)
        now = datetime.now(timezone.utc)
        _upsert(
            conn,
            t.training_progress,
            {
                "id": progress_id,
                "owner_user_id": owner_user_id,
                "repertoire_id": repertoire_id,
                "node_id": progress.node_id,
                "attempts": progress.attempts,
                "correct_attempts": progress.correct_attempts,
                "last_reviewed_at": progress.last_reviewed_at,
                "spaced_repetition_score": progress.spaced_repetition_score,
                "due_at": progress.due_at,
                "is_mastered": _bool_to_int(progress.is_mastered),
                "created_at": now,
                "updated_at": now,
            },
            conflict=[t.training_progress.c.id],
            update_cols=(
                "attempts", "correct_attempts", "last_reviewed_at",
                "spaced_repetition_score", "due_at", "is_mastered", "updated_at",
            ),
        )

    def lock_training_progress(
        self,
        conn: Connection,
        *,
        repertoire_id: str,
        node_id: str,
        owner_user_id: str,
    ) -> TrainingProgress:
        """Read-modify-write handle on one progress row inside an open transaction.

        Insert-claims the row when absent (``ON CONFLICT DO NOTHING``) and then
        reads it FOR UPDATE. On PostgreSQL concurrent updaters of the same node
        serialise here and each computes from the other's committed values, so
        parallel attempts can never lose an update; when the row was missing the
        racing inserter blocks on the claim instead of blind-overwriting. Returns
        a zeroed progress for a freshly claimed row. Follow up with
        ``write_training_progress`` before the transaction ends.
        """
        progress_id = self._training_progress_id(owner_user_id, repertoire_id, node_id)
        now = datetime.now(timezone.utc)
        conn.execute(
            _insert(conn, t.training_progress)
            .values(
                id=progress_id,
                owner_user_id=owner_user_id,
                repertoire_id=repertoire_id,
                node_id=node_id,
                attempts=0,
                correct_attempts=0,
                last_reviewed_at=None,
                spaced_repetition_score=0.0,
                due_at=None,
                is_mastered=0,
                created_at=now,
                updated_at=now,
            )
            .on_conflict_do_nothing(index_elements=[t.training_progress.c.id])
        )
        row = conn.execute(
            select(*_PROGRESS_COLUMNS)
            .where(t.training_progress.c.id == progress_id)
            .with_for_update()
        ).mappings().first()
        return self._training_progress_from_row(row)

    def load_training_progress(
        self,
        repertoire_id: str,
        node_id: str,
        *,
        owner_user_id: str,
    ) -> Optional[TrainingProgress]:
        progress_id = self._training_progress_id(owner_user_id, repertoire_id, node_id)
        with self.engine.connect() as conn:
            row = conn.execute(
                select(*_PROGRESS_COLUMNS).where(t.training_progress.c.id == progress_id)
            ).mappings().first()
        if row is None:
            return None
        return self._training_progress_from_row(row)

    def list_training_progress(
        self,
        repertoire_id: str,
        *,
        owner_user_id: str,
    ) -> List[TrainingProgress]:
        """All stored progress rows for a repertoire (for heatmap / due queue)."""
        tp = t.training_progress
        owner_cond = tp.c.owner_user_id == owner_user_id
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(tp).where(tp.c.repertoire_id == repertoire_id, owner_cond)
            ).mappings().all()
        return [self._training_progress_from_row(row) for row in rows]

    def _training_session_from_row(self, row: Mapping[str, Any]) -> TrainingSession:
        created_at = row["created_at"]
        updated_at = row["updated_at"]
        return TrainingSession(
            id=row["id"],
            repertoire_id=row["repertoire_id"],
            mode=TrainingMode(row["mode"]),
            line_order=_json_load(row["line_order_json"], []),
            current_index=row["current_index"],
            current_node_id=row["current_node_id"],
            mistakes=_json_load(row["mistakes_json"], []),
            mastered_nodes=_json_load(row["mastered_nodes_json"], []),
            created_at=created_at,
            updated_at=updated_at,
            seed=row["seed"],
            state_version=row["state_version"],
        )

    def _training_progress_from_row(self, row: Mapping[str, Any]) -> TrainingProgress:
        return TrainingProgress(
            node_id=row["node_id"],
            attempts=row["attempts"],
            correct_attempts=row["correct_attempts"],
            last_reviewed_at=row["last_reviewed_at"],
            spaced_repetition_score=row["spaced_repetition_score"],
            due_at=row["due_at"],
            is_mastered=_int_to_bool(row["is_mastered"]),
        )

    def _training_progress_id(
        self,
        owner_user_id: Optional[str],
        repertoire_id: str,
        node_id: str,
    ) -> str:
        payload = {
            "owner_user_id": owner_user_id or "default",
            "repertoire_id": repertoire_id,
            "node_id": node_id,
        }
        digest = sha256(_json_dump(payload).encode("utf-8")).hexdigest()[:32]
        return "training-progress:{0}".format(digest)
