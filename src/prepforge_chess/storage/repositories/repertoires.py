"""Repertoires persistence."""
from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional
from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import Connection
from prepforge_chess.core.models import Color, EngineEvaluation, MoveSource, OpeningNode, Repertoire
from prepforge_chess.storage import codec
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.common import _bool_to_int, _insert, _int_to_bool, _json_dump, _json_load, _upsert
from prepforge_chess.storage.repositories.evaluations import EvaluationRepository
from prepforge_chess.storage.repositories.training import TrainingRepository
from prepforge_chess.storage.repositories.settings import REVIEW_ARCHIVE_KEY, prune_review_archive


# Tree hydration does not use node timestamps. Avoid decoding two per node.
_NODE_COLUMNS = tuple(c for c in t.opening_nodes.c if c.name not in {"created_at", "updated_at"})


class RevisionConflict(RuntimeError):
    def __init__(self, current_revision: Optional[int]):
        super().__init__("This repertoire changed elsewhere. Reload it and re-apply the edit, or keep your draft.")
        self.current_revision = current_revision


class RepertoireRepository(EvaluationRepository, TrainingRepository):
    def expect_repertoire_revision(self, repertoire_id: str, revision: int) -> None:
        """Fence a request's writes at commit, not just at its earlier HTTP read."""
        self._expected_revisions[repertoire_id] = revision

    def _bump_revision(self, conn: Connection, repertoire_id: str) -> None:
        """D-02: every tree/metadata mutation bumps the repertoire revision, so a
        client holding ``base_revision`` can detect stale writes (409)."""
        stmt = update(t.repertoires).where(t.repertoires.c.id == repertoire_id)
        expected = self._expected_revisions.get(repertoire_id)
        if expected is not None:
            stmt = stmt.where(t.repertoires.c.revision == expected)
        changed = conn.execute(stmt.values(revision=t.repertoires.c.revision + 1))
        if expected is not None:
            if changed.rowcount != 1:
                current = conn.scalar(select(t.repertoires.c.revision).where(
                    t.repertoires.c.id == repertoire_id
                ))
                # Raising here rolls back the node/metadata writes in this transaction.
                raise RevisionConflict(current)
            self._expected_revisions[repertoire_id] = expected + 1

    def repertoire_revision(self, repertoire_id: str) -> Optional[int]:
        """Current mutation revision, or None when the repertoire is absent."""
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.repertoires.c.revision).where(
                    t.repertoires.c.id == repertoire_id
                )
            ).first()
        return int(row[0]) if row is not None else None

    def repertoire_reply_revision(self, repertoire_id: str) -> Optional[int]:
        """A mutation reply must describe its own commit, not a later writer."""
        if repertoire_id in self._expected_revisions:
            return self._expected_revisions[repertoire_id]
        return self.repertoire_revision(repertoire_id)

    def save_repertoire(self, repertoire: Repertoire, owner_user_id: Optional[str] = None) -> None:
        now = datetime.now(timezone.utc)
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.repertoires,
                {
                    "id": repertoire.id,
                    "owner_user_id": owner_user_id,
                    "name": repertoire.name,
                    "color": repertoire.color.value,
                    "root_fen": repertoire.root_fen,
                    "root_node_id": repertoire.root_node.id,
                    "notes": repertoire.notes,
                    "tags_json": _json_dump(repertoire.tags),
                    "is_active": 1 if getattr(repertoire, "is_active", True) else 0,
                    "created_at": now,
                    "updated_at": now,
                },
                conflict=[t.repertoires.c.id],
                update_cols=(
                    "name", "color", "root_fen", "root_node_id",
                    "notes", "tags_json", "is_active", "updated_at",
                ),
                # Never let a re-save reassign an existing owner; only fill a gap.
                coalesce_cols=("owner_user_id",),
            )

            pos_cache: Dict[str, int] = {}
            for node in self._walk_nodes(repertoire.root_node):
                self._save_opening_node(conn, node, pos_cache)
            self._bump_revision(conn, repertoire.id)

    def update_opening_nodes(self, repertoire_id: str, changes: List[Dict[str, Any]]) -> None:
        """Update only the supplied fields on existing nodes in one transaction."""
        if not changes:
            return
        with self.engine.begin() as conn:
            groups: Dict[str, Dict[str, Any]] = {}
            for change in changes:
                values = {key: value for key, value in change.items() if key != "id"}
                key = _json_dump(values)
                group = groups.setdefault(key, {"values": values, "ids": []})
                group["ids"].append(change["id"])
            for group in groups.values():
                values = group["values"]
                values["updated_at"] = datetime.now(timezone.utc)
                conn.execute(
                    update(t.opening_nodes)
                    .where(t.opening_nodes.c.id.in_(group["ids"]))
                    .where(t.opening_nodes.c.repertoire_id == repertoire_id)
                    .values(**values)
                )
            self._bump_revision(conn, repertoire_id)

    def set_node_annotations(self, repertoire_id: str, node_id: str, arrows: List[str], circles: List[str]) -> None:
        with self.engine.begin() as conn:
            changed = conn.execute(update(t.opening_nodes).where(
                t.opening_nodes.c.id == node_id,
                t.opening_nodes.c.repertoire_id == repertoire_id,
            ).values(
                arrows_json=_json_dump(arrows) if arrows else None,
                circles_json=_json_dump(circles) if circles else None,
                updated_at=datetime.now(timezone.utc),
            ))
            if changed.rowcount != 1:
                raise ValueError("node not found in repertoire")
            self._bump_revision(conn, repertoire_id)

    def save_changed_nodes(self, repertoire_id: str, nodes: List[OpeningNode], *, receipt: Optional[tuple] = None) -> None:
        """Persist changed or new nodes without walking the rest of the tree."""
        if not nodes:
            if receipt is not None:
                self.set_user_setting(*receipt)
            return
        with self.engine.begin() as conn:
            pos_cache: Dict[str, int] = {}
            rows = []
            for node in nodes:
                if node.repertoire_id != repertoire_id:
                    raise ValueError("node belongs to another repertoire")
                rows.append(self._opening_node_values(conn, node, pos_cache))
            stmt = _insert(conn, t.opening_nodes)
            stmt = stmt.on_conflict_do_update(
                index_elements=[t.opening_nodes.c.id],
                set_={name: stmt.excluded[name] for name in rows[0]
                      if name not in {"id", "created_at"}},
            )
            conn.execute(stmt, rows)
            self._bump_revision(conn, repertoire_id)
            if receipt is not None:
                self.write_user_setting(conn, *receipt)

    def update_repertoire_fields(self, repertoire_id: str, **fields: Any) -> None:
        if not fields:
            return
        if fields.keys() - {"name", "is_active"}:
            raise ValueError("unsupported repertoire fields")
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .values(**fields, updated_at=datetime.now(timezone.utc))
            )
            self._bump_revision(conn, repertoire_id)

    def _repertoire_from_rows(
        self,
        rep_row: Mapping[str, Any],
        node_rows: List[Mapping[str, Any]],
        evals: Mapping[int, EngineEvaluation],
    ) -> Optional[Repertoire]:
        """Assemble + hydrate a Repertoire from already-fetched rows.

        Shared by ``load_repertoire`` (single) and ``list_repertoires`` (batched)
        so both paths build identical trees from identical row shapes — the batch
        path just supplies rows fetched in bulk instead of one round trip each.
        """
        nodes: Dict[str, OpeningNode] = {}
        arriving_uci: Dict[str, Optional[str]] = {}
        for row in node_rows:
            arriving_uci[row["id"]] = row["uci"]
            nodes[row["id"]] = OpeningNode(
                id=row["id"],
                repertoire_id=row["repertoire_id"],
                parent_id=row["parent_id"],
                move=None,
                fen=rep_row["root_fen"],
                side_to_move=Color.WHITE,
                engine_evaluation=evals.get(row["engine_evaluation_id"]),
                maia_probability=row["maia_probability"],
                is_mainline=_int_to_bool(row["is_mainline"]),
                is_user_prepared_move=_int_to_bool(row["is_user_prepared_move"]),
                is_enabled=_int_to_bool(row["is_enabled"]),
                priority=row["priority"],
                comment=row["comment"],
                tags=_json_load(row["tags_json"], []),
                arrows=_json_load(row["arrows_json"], []),
                circles=_json_load(row["circles_json"], []),
                tactical_warning=row["tactical_warning"],
                strategic_idea=row["strategic_idea"],
                typical_plan=row["typical_plan"],
                source=MoveSource(row["source"]),
            )

        root_node = codec.hydrate_opening_tree(rep_row["root_fen"], nodes, arriving_uci)
        if root_node is None:
            return None
        if rep_row["root_node_id"] and rep_row["root_node_id"] in nodes:
            root_node = nodes[rep_row["root_node_id"]]

        repertoire = Repertoire(
            id=rep_row["id"],
            name=rep_row["name"],
            color=Color(rep_row["color"]),
            root_fen=rep_row["root_fen"],
            root_node=root_node,
            notes=rep_row["notes"],
            tags=_json_load(rep_row["tags_json"], []),
            is_active=_int_to_bool(rep_row["is_active"]),
        )
        repertoire._cached_health = _json_load(rep_row["health_json"], None)
        return repertoire

    def load_repertoire(
        self, repertoire_id: str, owner_user_id: Optional[str] = None,
        *, conn: Optional[Connection] = None,
    ) -> Optional[Repertoire]:
        with nullcontext(conn) if conn is not None else self.engine.connect() as conn:
            rep_row = conn.execute(
                select(t.repertoires).where(t.repertoires.c.id == repertoire_id)
            ).mappings().first()
            if rep_row is None:
                return None
            # Ownership gate: a repertoire owned by someone else is not-found to this owner.
            if owner_user_id is not None and rep_row["owner_user_id"] != owner_user_id:
                return None

            node_rows = conn.execute(
                select(*_NODE_COLUMNS).where(t.opening_nodes.c.repertoire_id == repertoire_id)
            ).mappings().all()
            evals = self._load_evaluations(
                conn, [row["engine_evaluation_id"] for row in node_rows]
            )
        return self._repertoire_from_rows(rep_row, node_rows, evals)

    def list_repertoires(self, owner_user_id: Optional[str] = None) -> List[Repertoire]:
        """Full repertoires (optionally owner-scoped), newest first.

        Batched read: one statement for the repertoire rows, one for every opening
        node across them, and one more for the referenced evaluations when any node
        has one — so the statement count is O(1) in the repertoire count (2 without
        referenced evaluations, 3 with), no matter how many repertoires are listed.
        The old shape (id list, then one ``load_repertoire`` round trip per id) grew
        linearly with N: roughly 1 + 2N statements without evaluations and
        1 + 3N with them (per repertoire: the repertoire row, its opening nodes,
        and its evaluation batch), re-walking a connection per row (N+1); public
        behaviour — set, order, and hydrated trees — is unchanged.
        """
        stmt = select(t.repertoires).order_by(t.repertoires.c.updated_at.desc())
        if owner_user_id is not None:
            stmt = stmt.where(t.repertoires.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            rep_rows = conn.execute(stmt).mappings().all()
            if not rep_rows:
                return []
            node_rows = conn.execute(
                select(*_NODE_COLUMNS).where(
                    t.opening_nodes.c.repertoire_id.in_(
                        [row["id"] for row in rep_rows]
                    )
                )
            ).mappings().all()
            evals = self._load_evaluations(
                conn, (row["engine_evaluation_id"] for row in node_rows)
            )
        nodes_by_rep: Dict[str, List[Mapping[str, Any]]] = {}
        for row in node_rows:
            nodes_by_rep.setdefault(row["repertoire_id"], []).append(row)
        out: List[Repertoire] = []
        for rep_row in rep_rows:
            repertoire = self._repertoire_from_rows(
                rep_row, nodes_by_rep.get(rep_row["id"], []), evals
            )
            if repertoire is not None:
                out.append(repertoire)
        return out

    def list_owner_repertoire_listings(
        self, owner_user_id: str
    ) -> List[Dict[str, Any]]:
        """Owner listing metadata with grouped live mastery counts, no tree hydration."""
        stmt = (
            select(
                t.repertoires.c.id,
                t.repertoires.c.name,
                t.repertoires.c.color,
                t.repertoires.c.root_fen,
                t.repertoires.c.notes,
                t.repertoires.c.tags_json,
                t.repertoires.c.is_active,
                t.repertoires.c.team_id,
                t.repertoires.c.visibility,
                t.repertoires.c.health_json,
                t.repertoires.c.revision,
            )
            .where(t.repertoires.c.owner_user_id == owner_user_id)
            .order_by(t.repertoires.c.updated_at.desc())
        )
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        # Every mastery category can change at a due-time boundary.
        mastery_counts = self.mastery_counts_by_repertoire(owner_user_id)
        out = []
        for row in rows:
            health = _json_load(row["health_json"], None)
            if health is not None:
                health = dict(health)
                health.update(mastery_counts.get(row["id"], {
                    "trainable": 0, "mastered": 0, "learning": 0, "due": 0,
                    "weak": 0, "untrained": 0, "mastery_pct": 0,
                }))
            out.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "color": row["color"],
                    "root_fen": row["root_fen"],
                    "notes": row["notes"],
                    "tags": _json_load(row["tags_json"], []),
                    "is_active": _int_to_bool(row["is_active"]),
                    "team_id": row["team_id"],
                    "visibility": row["visibility"] or "private",
                    # Cached coverage summary (NULL until the rep is first
                    # opened/trained) with live mastery counts.
                    "health": health,
                    "revision": int(row["revision"] or 0),
                }
            )
        return out

    def set_repertoire_health(
        self, repertoire_id: str, health: Optional[Dict[str, Any]],
        *, expected_cache: Optional[Dict[str, Any]] = None, cache_snapshot: bool = False,
    ) -> None:
        """Persist the denormalized health summary for the dashboard list. Called
        from the spots that already compute health off a loaded tree (Build payload,
        train summary), so it adds a single cheap UPDATE and no extra tree walk."""
        if cache_snapshot:
            # The loaded cache value is an optimistic fence: a later cache
            # writer or tree mutation makes this update a no-op, in one SQL.
            with self.engine.begin() as conn:
                conn.execute(update(t.repertoires).where(
                    t.repertoires.c.id == repertoire_id,
                    t.repertoires.c.revision == health["revision"],
                    t.repertoires.c.health_json.is_not_distinct_from(
                        _json_dump(expected_cache) if expected_cache is not None else None
                    ),
                ).values(health_json=_json_dump(health)))
            return
        with self.engine.begin() as conn:
            # Serialize cache writers on the same repertoire row. SQLite's no-op
            # UPDATE takes its write lock; PostgreSQL locks this row until commit.
            conn.execute(update(t.repertoires).where(
                t.repertoires.c.id == repertoire_id
            ).values(health_json=t.repertoires.c.health_json))
            row = conn.execute(select(
                t.repertoires.c.revision, t.repertoires.c.health_json
            ).where(t.repertoires.c.id == repertoire_id)).first()
            if row is None:
                return
            if health is not None and health.get("revision") is not None:
                if health["revision"] != row[0]:
                    return
                previous = _json_load(row[1], {}) or {}
                if (previous.get("revision") == health["revision"]
                        and previous.get("computed_at", "") > health.get("computed_at", "")):
                    return
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .where(t.repertoires.c.health_json.is_distinct_from(
                    _json_dump(health) if health is not None else None
                ))
                .values(health_json=_json_dump(health) if health is not None else None)
            )

    def list_repertoire_metas(
        self, owner_user_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Lightweight ``(id, name, is_active)`` rows for the owner's
        repertoires, newest first — same set and order as ``list_repertoires``
        but without loading any opening tree. Lets a caller decide *which*
        repertoires to act on (e.g. the active ones for a mixed session) before
        paying to load the trees it actually needs."""
        stmt = select(
            t.repertoires.c.id,
            t.repertoires.c.name,
            t.repertoires.c.is_active,
        ).order_by(t.repertoires.c.updated_at.desc())
        if owner_user_id is not None:
            stmt = stmt.where(t.repertoires.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "is_active": _int_to_bool(row["is_active"]),
            }
            for row in rows
        ]

    def count_repertoires(self, owner_user_id: Optional[str] = None) -> int:
        """Number of repertoires owned by ``owner_user_id`` (all rows if None),
        without loading any opening trees — used by the Free-plan quota gate."""
        stmt = select(func.count()).select_from(t.repertoires)
        if owner_user_id is not None:
            stmt = stmt.where(t.repertoires.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            return int(conn.execute(stmt).scalar_one())

    def repertoire_meta(self, repertoire_id: str, *, conn: Optional[Connection] = None) -> Optional[Dict[str, Any]]:
        """Lightweight ``(id, name, is_active, owner_user_id, team_id, visibility)`` for
        owner/share-gating and write responses, without loading the whole opening tree.
        ``None`` if absent; ``owner_user_id``/``team_id`` are ``None`` for an
        unclaimed/unshared row, and ``visibility`` defaults to ``"private"``."""
        with nullcontext(conn) if conn is not None else self.engine.connect() as conn:
            row = conn.execute(
                select(
                    t.repertoires.c.id,
                    t.repertoires.c.name,
                    t.repertoires.c.is_active,
                    t.repertoires.c.owner_user_id,
                    t.repertoires.c.team_id,
                    t.repertoires.c.visibility,
                    t.repertoires.c.revision,
                    t.repertoires.c.share_rev,
                    t.repertoires.c.share_enabled,
                    t.repertoires.c.share_expires_at,
                ).where(t.repertoires.c.id == repertoire_id)
            ).mappings().first()
        if row is None:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "is_active": _int_to_bool(row["is_active"]),
            "owner_user_id": row["owner_user_id"],
            "team_id": row["team_id"],
            "visibility": row["visibility"] or "private",
            "revision": int(row["revision"] or 0),
            "share_rev": int(row["share_rev"] or 0),
            "share_enabled": _int_to_bool(row["share_enabled"]),
            "share_expires_at": row["share_expires_at"],
        }

    def set_share_state(
        self,
        repertoire_id: str,
        *,
        enabled: Optional[bool] = None,
        rotate: bool = False,
        expires_at: Optional[datetime] = None,
        clear_expiry: bool = False,
    ) -> Dict[str, Any]:
        """F-01: public share-link governance. ``enabled`` toggles the link
        independently of team sharing, ``rotate`` bumps ``share_rev`` (killing
        every previously minted link), ``expires_at`` or
        ``clear_expiry`` set the optional deadline. Returns the fresh state."""
        values: Dict[str, Any] = {"updated_at": datetime.now(timezone.utc)}
        if enabled is not None:
            values["share_enabled"] = 1 if enabled else 0
        if rotate:
            values["share_rev"] = t.repertoires.c.share_rev + 1
        if clear_expiry:
            values["share_expires_at"] = None
        elif expires_at is not None:
            values["share_expires_at"] = expires_at
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .values(**values)
            )
            row = conn.execute(
                select(
                    t.repertoires.c.share_rev,
                    t.repertoires.c.share_enabled,
                    t.repertoires.c.share_expires_at,
                ).where(t.repertoires.c.id == repertoire_id)
            ).first()
        return {
            "share_rev": int(row[0] or 0),
            "share_enabled": bool(row[1]),
            "share_expires_at": row[2],
        }

    def set_repertoire_sharing(
        self, repertoire_id: str, team_id: Optional[str], visibility: str
    ) -> None:
        """Set the team a repertoire is shared with and its visibility. Pass
        ``team_id=None`` + ``visibility='private'`` to unshare."""
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .values(team_id=team_id, visibility=visibility, updated_at=datetime.now(timezone.utc))
            )

    def list_team_shared_repertoires(self, team_ids: List[str]) -> List[Dict[str, Any]]:
        """Lightweight metas of every repertoire shared (``visibility='team'``) to any
        of ``team_ids`` — for the team members' read-only listing. Empty list if no
        team_ids, so a non-member never widens the query."""
        if not team_ids:
            return []
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    t.repertoires.c.id,
                    t.repertoires.c.name,
                    t.repertoires.c.color,
                    t.repertoires.c.root_fen,
                    t.repertoires.c.owner_user_id,
                    t.repertoires.c.team_id,
                )
                .where(t.repertoires.c.team_id.in_(team_ids))
                .where(t.repertoires.c.visibility == "team")
                .order_by(t.repertoires.c.updated_at.desc())
            ).mappings().all()
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "color": r["color"],
                "root_fen": r["root_fen"],
                "owner_user_id": r["owner_user_id"],
                "team_id": r["team_id"],
            }
            for r in rows
        ]

    def list_repertoires_shared_to_team(self, team_id: str) -> List[Dict[str, Any]]:
        """Lightweight metas of repertoires shared (``visibility='team'``) to one team."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    t.repertoires.c.id,
                    t.repertoires.c.name,
                    t.repertoires.c.color,
                    t.repertoires.c.owner_user_id,
                )
                .where(t.repertoires.c.team_id == team_id)
                .where(t.repertoires.c.visibility == "team")
                .order_by(t.repertoires.c.updated_at.desc())
            ).mappings().all()
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "color": r["color"],
                "owner_user_id": r["owner_user_id"],
            }
            for r in rows
        ]

    def unshare_all_for_team(self, team_id: str, *, conn: Optional[Connection] = None) -> None:
        """Unshare in the caller's team-deletion transaction when supplied."""
        stmt = (update(t.repertoires).where(t.repertoires.c.team_id == team_id)
                .values(team_id=None, visibility="private", updated_at=datetime.now(timezone.utc)))
        if conn is not None:
            conn.execute(stmt)
        else:
            with self.engine.begin() as own_conn:
                own_conn.execute(stmt)

    def set_repertoire_active(self, repertoire_id: str, active: bool) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .values(is_active=_bool_to_int(active), updated_at=datetime.now(timezone.utc))
            )

    def claim_repertoire(self, repertoire_id: str, owner_user_id: str) -> None:
        """Stamp ownership on a just-created repertoire (the builder saves it
        ownerless). No-op if the row already has an owner — never reassign one
        user's repertoire to another."""
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(
                    t.repertoires.c.id == repertoire_id,
                    t.repertoires.c.owner_user_id.is_(None),
                )
                .values(owner_user_id=owner_user_id)
            )

    def delete_repertoire(self, repertoire_id: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(delete(t.repertoires).where(t.repertoires.c.id == repertoire_id))

    def delete_opening_nodes(self, repertoire_id: str, node_ids: List[str], *, receipt: Optional[tuple] = None) -> None:
        if not node_ids:
            return
        week_ago = datetime.now(timezone.utc) - timedelta(days=7)
        with self.engine.begin() as conn:
            # Progress rows cascade away with their nodes; keep the review
            # timestamps of this week so the dashboard's review count stays put.
            tp = t.training_progress
            reviewed = conn.execute(
                select(tp.c.owner_user_id, tp.c.last_reviewed_at).where(
                    tp.c.repertoire_id == repertoire_id,
                    tp.c.node_id.in_(node_ids),
                    tp.c.last_reviewed_at.is_not(None),
                    tp.c.last_reviewed_at >= week_ago,
                )
            ).all()
            # Clear references that don't cascade, otherwise the node delete trips
            # a FOREIGN KEY constraint (e.g. a live training session still points
            # at one of these nodes via current_node_id).
            conn.execute(
                update(t.training_sessions)
                .where(t.training_sessions.c.current_node_id.in_(node_ids))
                .values(current_node_id=None)
            )
            conn.execute(
                delete(t.opening_nodes).where(
                    t.opening_nodes.c.repertoire_id == repertoire_id,
                    t.opening_nodes.c.id.in_(node_ids),
                )
            )
            self._bump_revision(conn, repertoire_id)
            if receipt is not None:
                self.write_user_setting(conn, *receipt)
            by_owner: Dict[str, List[str]] = {}
            for owner, stamp in reviewed:
                if owner:
                    by_owner.setdefault(owner, []).append(stamp.isoformat())
            for owner, stamps in sorted(by_owner.items()):
                cur = self.lock_user_setting(conn, owner, REVIEW_ARCHIVE_KEY, [])
                self.write_user_setting(conn, owner, REVIEW_ARCHIVE_KEY, prune_review_archive(
                    (cur if isinstance(cur, list) else []) + stamps, week_ago.isoformat()
                ))

    def _save_opening_node(
        self,
        conn: Connection,
        node: OpeningNode,
        pos_cache: Optional[Dict[str, int]] = None,
    ) -> None:
        values = self._opening_node_values(conn, node, pos_cache)
        _upsert(
            conn, t.opening_nodes, values,
            conflict=[t.opening_nodes.c.id],
            update_cols=tuple(name for name in values if name not in {"id", "created_at"}),
        )

    def _opening_node_values(
        self, conn: Connection, node: OpeningNode,
        pos_cache: Optional[Dict[str, int]] = None,
    ) -> Dict[str, Any]:
        now = datetime.now(timezone.utc)
        if pos_cache is None:
            pos_cache = {}
        arriving = node.move.uci if node.move is not None else None
        eval_fen = node.fen
        engine_evaluation_id = self._save_engine_evaluation(
            conn, node.engine_evaluation, eval_fen, pos_cache
        )
        return {
                "id": node.id,
                "repertoire_id": node.repertoire_id,
                "parent_id": node.parent_id,
                "uci": arriving,
                "engine_evaluation_id": engine_evaluation_id,
                "maia_probability": node.maia_probability,
                "is_mainline": _bool_to_int(node.is_mainline),
                "is_user_prepared_move": _bool_to_int(node.is_user_prepared_move),
                "is_enabled": _bool_to_int(node.is_enabled),
                "priority": node.priority,
                "comment": node.comment,
                "tags_json": _json_dump(node.tags) if node.tags else None,
                "arrows_json": _json_dump(node.arrows) if node.arrows else None,
                "circles_json": _json_dump(node.circles) if node.circles else None,
                "tactical_warning": node.tactical_warning,
                "strategic_idea": node.strategic_idea,
                "typical_plan": node.typical_plan,
                "source": node.source.value,
                "created_at": now,
                "updated_at": now,
            }

    def _walk_nodes(self, root: OpeningNode) -> Iterable[OpeningNode]:
        yield root
        for child in root.children:
            for node in self._walk_nodes(child):
                yield node
