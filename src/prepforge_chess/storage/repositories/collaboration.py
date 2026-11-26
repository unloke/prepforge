"""Collaboration persistence: the activity feed, inverse edits and position discussions.

Every write here runs inside the repertoire's ``repertoire_edit`` lock and bumps
its revision, so devices catching up see discussions and reverts like any edit.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import delete, select, update
from sqlalchemy.engine import Connection

from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.repertoires import RepertoireRepository, expand_op_node_row

_REVERT_CHUNK = 400
_REVERT_INSERT_CHUNK = 40


class EditNotFound(LookupError):
    """The op is no longer in recent activity (404)."""


class RevertConflict(RuntimeError):
    """A newer edit stands in the way of the inverse edit (409)."""


class CollaborationRepository(RepertoireRepository):
    # ----------------------------------------------------------------- activity

    def activity_rows(self, repertoire_id: str) -> Sequence[Mapping[str, Any]]:
        """The kept op log, newest first, with each actor's display name and email."""
        with self.engine.connect() as conn:
            return conn.execute(select(t.repertoire_ops, t.users.c.display_name, t.users.c.email).select_from(
                t.repertoire_ops.outerjoin(t.users, t.users.c.id == t.repertoire_ops.c.actor_user_id)
            ).where(t.repertoire_ops.c.repertoire_id == repertoire_id).order_by(
                t.repertoire_ops.c.revision.desc()
            )).mappings().all()

    def revert_op(
        self,
        conn: Connection,
        rid: str,
        revision: int,
        *,
        before_delete: Callable[[Connection, List[str]], None],
    ) -> List[str]:
        """Apply the inverse of op ``revision`` on the locked connection and log it.

        Raises ``EditNotFound`` or ``RevertConflict``. ``before_delete`` runs on
        each chunk of node ids right before they are deleted, so the caller can
        release what other domains hold on them. Returns the removed node ids."""
        encoded = conn.scalar(select(t.repertoire_ops.c.op_json).where(
            t.repertoire_ops.c.repertoire_id == rid, t.repertoire_ops.c.revision == revision))
        if encoded is None:
            raise EditNotFound("This edit is no longer in recent activity.")
        op = json.loads(encoded)
        delta, metadata = op.get("delta", {}), op.get("metadata", {})
        if not delta and not metadata:
            raise RevertConflict("This event has no reversible tree edit.")
        current = self._node_rows(conn, rid, delta)
        for node_id, change in delta.items():
            before_raw, after_raw = change["before"], change["after"]
            after = (
                expand_op_node_row(after_raw, rid, node_id)
                if before_raw is None and after_raw is not None
                else after_raw
            )
            row = current.get(node_id)
            if after is None:
                if row is not None:
                    raise RevertConflict("A deleted move has been restored or replaced. Refresh activity.")
            elif row is None or any(row[key] != value for key, value in after.items()):
                raise RevertConflict("These moves were edited again. Review the newer edit first.")
        rep = conn.execute(select(t.repertoires).where(t.repertoires.c.id == rid)).mappings().one()
        for key, change in metadata.items():
            if rep[key] != change["after"]:
                raise RevertConflict("The repertoire was renamed or changed again. Review the newer edit first.")
        removing = {node_id for node_id, change in delta.items() if change["before"] is None}
        restoring = {
            node_id: expand_op_node_row(change["before"], rid, node_id)
            for node_id, change in delta.items()
            if change["after"] is None
        }
        removing_list = sorted(removing)
        if removing:
            for offset in range(0, len(removing_list), _REVERT_CHUNK):
                chunk = removing_list[offset:offset + _REVERT_CHUNK]
                child_ids = conn.scalars(
                    select(t.opening_nodes.c.id).where(t.opening_nodes.c.parent_id.in_(chunk))
                ).all()
                if any(cid not in removing for cid in child_ids):
                    raise RevertConflict("New moves continue this line. Remove those continuations first.")
        for row in restoring.values():
            parent = row["parent_id"]
            if parent not in restoring and not conn.scalar(select(t.opening_nodes.c.id).where(
                t.opening_nodes.c.id == parent, t.opening_nodes.c.repertoire_id == rid)):
                raise RevertConflict("The parent line is missing. Restore its deletion first.")
        # Inserts follow parents; partial updates only undo the fields this op wrote.
        pending = dict(restoring)
        while pending:
            ready = [node_id for node_id, row in pending.items() if row["parent_id"] not in pending]
            if not ready:
                raise RevertConflict("This edit cannot restore a valid move tree.")
            for offset in range(0, len(ready), _REVERT_INSERT_CHUNK):
                conn.execute(
                    t.opening_nodes.insert(),
                    [pending.pop(node_id) for node_id in ready[offset:offset + _REVERT_INSERT_CHUNK]],
                )
        for node_id, change in delta.items():
            if change["before"] is not None and change["after"] is not None:
                conn.execute(update(t.opening_nodes).where(t.opening_nodes.c.id == node_id).values(**change["before"]))
        if removing:
            for offset in range(0, len(removing_list), _REVERT_CHUNK):
                before_delete(conn, removing_list[offset:offset + _REVERT_CHUNK])
            # Deleting a parent can cascade into nodes in any later batch.
            for offset in range(0, len(removing_list), _REVERT_CHUNK):
                chunk = removing_list[offset:offset + _REVERT_CHUNK]
                conn.execute(delete(t.opening_nodes).where(t.opening_nodes.c.id.in_(chunk)))
        old_meta = {key: rep[key] for key in metadata}
        if metadata:
            conn.execute(update(t.repertoires).where(t.repertoires.c.id == rid).values(
                **{key: change["before"] for key, change in metadata.items()}))
        self.bump_revision(conn, rid, nodes=set(delta) - removing, removed=removing,
                           before=current, meta=bool(metadata), metadata_before=old_meta,
                           reverted_revision=revision)
        return removing_list

    # -------------------------------------------------------------- discussions

    def discussions(self, repertoire_id: str) -> Tuple[Sequence[Mapping[str, Any]], Sequence[Mapping[str, Any]]]:
        """The repertoire's threads (oldest first) and all their messages with
        each author's display name and email."""
        with self.engine.connect() as conn:
            threads = conn.execute(select(t.position_threads).where(
                t.position_threads.c.repertoire_id == repertoire_id).order_by(t.position_threads.c.created_at)).mappings().all()
            messages = conn.execute(select(t.position_messages, t.users.c.display_name, t.users.c.email).select_from(
                t.position_messages.join(t.position_threads, t.position_threads.c.id == t.position_messages.c.thread_id)
                .outerjoin(t.users, t.users.c.id == t.position_messages.c.author_id)
            ).where(t.position_threads.c.repertoire_id == repertoire_id).order_by(
                t.position_messages.c.created_at, t.position_messages.c.id)).mappings().all()
        return threads, messages

    def discussion_thread(self, conn: Connection, repertoire_id: str, thread_id: str) -> Optional[Mapping[str, Any]]:
        return conn.execute(select(t.position_threads).where(
            t.position_threads.c.repertoire_id == repertoire_id, t.position_threads.c.id == thread_id)).mappings().first()

    def discussion_thread_at(self, conn: Connection, repertoire_id: str, position_key: str) -> Optional[str]:
        """The id of the thread on this position, if one exists."""
        return conn.scalar(select(t.position_threads.c.id).where(
            t.position_threads.c.repertoire_id == repertoire_id, t.position_threads.c.position_key == position_key))

    def start_discussion_thread(self, conn: Connection, **values: Any) -> None:
        conn.execute(t.position_threads.insert().values(**values))

    def add_discussion_message(self, conn: Connection, **values: Any) -> None:
        conn.execute(t.position_messages.insert().values(**values))

    def update_discussion_thread(self, conn: Connection, thread_id: str, values: Dict[str, Any]) -> None:
        conn.execute(update(t.position_threads).where(t.position_threads.c.id == thread_id).values(**values))
