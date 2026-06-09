from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Dict, Iterable, List, Mapping, Optional

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Connection, Engine

from prepforge_chess.core.models import (
    AnalysisResult,
    Color,
    EngineEvaluation,
    Game,
    GameResult,
    MoveClassification,
    MoveRecord,
    MoveSource,
    OpeningNode,
    Repertoire,
    TrainingMode,
    TrainingProgress,
    TrainingSession,
)
from prepforge_chess.storage import sa_tables as t

# ``user_profiles`` columns that ``schema.sql`` defaulted server-side. ``sa_tables``
# carries no server defaults (the design choice: the repository supplies defaults in
# Python), so ``create_user_profile`` provides them explicitly here.
_DEFAULT_ENGINE = "stockfish"
_DEFAULT_ANALYSIS_DEPTH = 16


def _now_text() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def _json_load(value: Optional[str], default: Any) -> Any:
    if value is None:
        return default
    return json.loads(value)


def _dt_to_text(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value is not None else None


def _dt_from_text(value: Optional[str]) -> Optional[datetime]:
    return datetime.fromisoformat(value) if value else None


def _bool_to_int(value: bool) -> int:
    return 1 if value else 0


def _int_to_bool(value: int) -> bool:
    return bool(value)


def _insert(conn: Connection, table):
    """Dialect-aware INSERT so ``on_conflict_do_update`` (upsert) works on both
    backends: Postgres and SQLite spell ``ON CONFLICT`` differently."""
    if conn.dialect.name == "postgresql":
        return pg_insert(table)
    return sqlite_insert(table)


def _upsert(
    conn: Connection,
    table,
    values: Dict[str, Any],
    *,
    conflict: List,
    update_cols: Iterable[str],
    coalesce_cols: Iterable[str] = (),
) -> None:
    """INSERT ... ON CONFLICT DO UPDATE. ``update_cols`` are set from the proposed
    (``excluded``) row; ``coalesce_cols`` keep the existing value when present and
    only fill a gap — used so a re-save never reassigns an established owner."""
    stmt = _insert(conn, table).values(**values)
    set_ = {name: stmt.excluded[name] for name in update_cols}
    for name in coalesce_cols:
        set_[name] = func.coalesce(table.c[name], stmt.excluded[name])
    stmt = stmt.on_conflict_do_update(index_elements=conflict, set_=set_)
    conn.execute(stmt)


class PrepForgeRepository:
    """SQLAlchemy persistence for shared domain models.

    The repository is intentionally narrow: it stores and loads domain objects
    without putting analysis, training, or generation decisions into SQL code. It
    runs against the ``storage/sa_tables`` Core tables, so the same code drives
    SQLite (dev/tests) and Postgres (prod).
    """

    def __init__(self, engine: Engine):
        self.engine = engine

    # ---- Identity / sessions (multi-tenancy foundation) -----------------------
    # Browsers carry an opaque session token in a cookie; the server stores only its
    # hash here and maps it to a ``user_profiles`` row. A not-logged-in browser gets a
    # "guest" profile; a Lichess login finds-or-creates a profile keyed by username and
    # migrates the guest's data into it (see PrepForgeWebApp).

    def create_user_profile(
        self, *, display_name: str, lichess_username: Optional[str] = None
    ) -> str:
        profile_id = str(uuid.uuid4())
        now = _now_text()
        with self.engine.begin() as conn:
            conn.execute(
                t.user_profiles.insert().values(
                    id=profile_id,
                    display_name=display_name,
                    lichess_username=lichess_username,
                    preferred_engine=_DEFAULT_ENGINE,
                    default_analysis_depth=_DEFAULT_ANALYSIS_DEPTH,
                    settings_json="{}",
                    created_at=now,
                    updated_at=now,
                )
            )
        return profile_id

    def ensure_profile(self, profile_id: str, *, display_name: str) -> str:
        """Idempotently create the ``user_profiles`` row a FastAPI ``User`` owns.

        Phase 2b bridge: the SaaS identity (``users.id``) IS the legacy data-owner id
        (``user_profiles.id``). The first time an authenticated user touches an
        owned-data endpoint we materialize their profile here; ``ON CONFLICT DO
        NOTHING`` keeps the call a no-op (and never clobbers ``display_name`` /
        ``settings_json``) on every subsequent request. Returns ``profile_id``.
        """
        now = _now_text()
        with self.engine.begin() as conn:
            stmt = (
                _insert(conn, t.user_profiles)
                .values(
                    id=profile_id,
                    display_name=display_name,
                    lichess_username=None,
                    preferred_engine=_DEFAULT_ENGINE,
                    default_analysis_depth=_DEFAULT_ANALYSIS_DEPTH,
                    settings_json="{}",
                    created_at=now,
                    updated_at=now,
                )
                .on_conflict_do_nothing(index_elements=["id"])
            )
            conn.execute(stmt)
        return profile_id

    def session_user(self, token_hash: str) -> Optional[str]:
        """Return the user_profile_id for a session token hash (and touch last_seen)."""
        with self.engine.begin() as conn:
            row = conn.execute(
                select(t.user_sessions.c.user_profile_id).where(
                    t.user_sessions.c.token_hash == token_hash
                )
            ).mappings().first()
            if row is None:
                return None
            conn.execute(
                update(t.user_sessions)
                .where(t.user_sessions.c.token_hash == token_hash)
                .values(last_seen_at=_now_text())
            )
            return row["user_profile_id"]

    def create_guest_session(self, token_hash: str) -> str:
        """Mint a fresh guest profile + session for a new browser. Returns the profile id."""
        profile_id = self.create_user_profile(display_name="Guest")
        now = _now_text()
        with self.engine.begin() as conn:
            conn.execute(
                t.user_sessions.insert().values(
                    token_hash=token_hash,
                    user_profile_id=profile_id,
                    created_at=now,
                    last_seen_at=now,
                )
            )
        return profile_id

    def rebind_session(self, token_hash: str, user_profile_id: str) -> None:
        """Point an existing session at a different profile (e.g. guest → Lichess account)."""
        with self.engine.begin() as conn:
            conn.execute(
                update(t.user_sessions)
                .where(t.user_sessions.c.token_hash == token_hash)
                .values(user_profile_id=user_profile_id, last_seen_at=_now_text())
            )

    def delete_session(self, token_hash: str) -> None:
        """Drop a session row so its cookie can no longer authenticate (sign out). The
        underlying user_profile and its owned data are left intact."""
        with self.engine.begin() as conn:
            conn.execute(
                delete(t.user_sessions).where(t.user_sessions.c.token_hash == token_hash)
            )

    def find_profile_by_lichess(self, username: str) -> Optional[str]:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.user_profiles.c.id).where(
                    func.lower(t.user_profiles.c.lichess_username) == func.lower(username)
                )
            ).mappings().first()
        return row["id"] if row is not None else None

    def ensure_lichess_profile(self, username: str) -> str:
        existing = self.find_profile_by_lichess(username)
        if existing is not None:
            return existing
        return self.create_user_profile(display_name=username, lichess_username=username)

    def profile_lichess_username(self, profile_id: str) -> Optional[str]:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.user_profiles.c.lichess_username).where(
                    t.user_profiles.c.id == profile_id
                )
            ).mappings().first()
        return row["lichess_username"] if row is not None else None

    def get_profile_setting(
        self, profile_id: str, key: str, default: Any = None
    ) -> Any:
        """Read one key from a profile's ``settings_json`` blob (per-user state such
        as the Lichess OAuth token). Unknown profile/key returns ``default``."""
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.user_profiles.c.settings_json).where(
                    t.user_profiles.c.id == profile_id
                )
            ).mappings().first()
        if row is None:
            return default
        data = _json_load(row["settings_json"], {})
        return data.get(key, default) if isinstance(data, dict) else default

    def set_profile_setting(self, profile_id: str, key: str, value: Any) -> None:
        """Upsert one key into a profile's ``settings_json`` (per-user state). A
        ``None`` value deletes the key. Raises if the profile does not exist so a
        token can never be written to a phantom owner."""
        with self.engine.begin() as conn:
            row = conn.execute(
                select(t.user_profiles.c.settings_json).where(
                    t.user_profiles.c.id == profile_id
                )
            ).mappings().first()
            if row is None:
                raise ValueError("unknown profile: {0}".format(profile_id))
            data = _json_load(row["settings_json"], {})
            if not isinstance(data, dict):
                data = {}
            if value is None:
                data.pop(key, None)
            else:
                data[key] = value
            conn.execute(
                update(t.user_profiles)
                .where(t.user_profiles.c.id == profile_id)
                .values(settings_json=_json_dump(data), updated_at=_now_text())
            )

    def reassign_owner(self, from_user_id: str, to_user_id: str) -> None:
        """Move every owned top-level row from one profile to another (guest → account)."""
        if from_user_id == to_user_id:
            return
        with self.engine.begin() as conn:
            conn.execute(
                update(t.games)
                .where(t.games.c.owner_user_id == from_user_id)
                .values(owner_user_id=to_user_id)
            )
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.user_profile_id == from_user_id)
                .values(user_profile_id=to_user_id)
            )

    def save_game(self, game: Game, owner_user_id: Optional[str] = None) -> None:
        now = _now_text()
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.games,
                {
                    "id": game.id,
                    "source": game.source.value,
                    "initial_fen": game.initial_fen,
                    "white": game.white,
                    "black": game.black,
                    "result": game.result.value,
                    "event": game.event,
                    "site": game.site,
                    "played_at": _dt_to_text(game.played_at),
                    "pgn": game.pgn,
                    "lichess_id": game.lichess_id,
                    "tags_json": _json_dump(game.tags),
                    "owner_user_id": owner_user_id,
                    "created_at": now,
                    "updated_at": now,
                },
                conflict=[t.games.c.id],
                update_cols=(
                    "source", "initial_fen", "white", "black", "result", "event",
                    "site", "played_at", "pgn", "lichess_id", "tags_json", "updated_at",
                ),
                # Never let a re-save reassign an existing owner; only fill a gap.
                coalesce_cols=("owner_user_id",),
            )

            for move in game.moves:
                self._save_move(
                    conn,
                    move=move,
                    move_id=self._game_move_id(game.id, move.ply),
                    game_id=game.id,
                )

    def load_game(self, game_id: str, owner_user_id: Optional[str] = None) -> Optional[Game]:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.games).where(t.games.c.id == game_id)
            ).mappings().first()
            if row is None:
                return None
            # Ownership gate: when an owner is supplied, a game owned by someone else is
            # treated as not-found (no IDOR via a guessed/known id).
            if owner_user_id is not None and row["owner_user_id"] != owner_user_id:
                return None

            move_rows = conn.execute(
                select(t.moves).where(t.moves.c.game_id == game_id).order_by(t.moves.c.ply)
            ).mappings().all()
            moves = [self._move_from_row(conn, move_row) for move_row in move_rows]

        return Game(
            id=row["id"],
            source=MoveSource(row["source"]),
            initial_fen=row["initial_fen"],
            moves=moves,
            white=row["white"],
            black=row["black"],
            result=GameResult(row["result"]),
            event=row["event"],
            site=row["site"],
            played_at=_dt_from_text(row["played_at"]),
            pgn=row["pgn"],
            lichess_id=row["lichess_id"],
            tags=_json_load(row["tags_json"], {}),
        )

    def find_game_id_by_lichess_id(
        self, lichess_id: str, owner_user_id: Optional[str] = None
    ) -> Optional[str]:
        """Dedup lookup for a Lichess game. Owner-scoped: when an owner is supplied
        only that owner's own copy counts, so two users importing the same game each
        keep their own row instead of colliding on a shared one. Unscoped (None)
        keeps the legacy global behaviour for CLI/internal callers."""
        stmt = select(t.games.c.id).where(t.games.c.lichess_id == lichess_id)
        if owner_user_id is not None:
            stmt = stmt.where(t.games.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            row = conn.execute(stmt).mappings().first()
        return row["id"] if row is not None else None

    def has_game(self, game_id: str) -> bool:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.games.c.id).where(t.games.c.id == game_id)
            ).first()
        return row is not None

    def list_games(self, owner_user_id: Optional[str] = None) -> List[Game]:
        stmt = select(t.games.c.id).order_by(t.games.c.created_at.desc())
        if owner_user_id is not None:
            stmt = stmt.where(t.games.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            ids = [row["id"] for row in conn.execute(stmt).mappings().all()]
        return [game for game in (self.load_game(game_id) for game_id in ids) if game is not None]

    def save_repertoire(self, repertoire: Repertoire, owner_user_id: Optional[str] = None) -> None:
        now = _now_text()
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.repertoires,
                {
                    "id": repertoire.id,
                    "user_profile_id": owner_user_id,
                    "name": repertoire.name,
                    "color": repertoire.color.value,
                    "root_fen": repertoire.root_fen,
                    "root_node_id": repertoire.root_node.id,
                    "main_engine": repertoire.main_engine,
                    "human_model": repertoire.human_model,
                    "branch_depth": repertoire.branch_depth,
                    "opponent_branch_threshold": repertoire.opponent_branch_threshold,
                    "sub_branch_threshold": repertoire.sub_branch_threshold,
                    "max_total_nodes": repertoire.max_total_nodes,
                    "max_line_length": repertoire.max_line_length,
                    "notes": repertoire.notes,
                    "tags_json": _json_dump(repertoire.tags),
                    "is_active": 1 if getattr(repertoire, "is_active", True) else 0,
                    "created_at": now,
                    "updated_at": now,
                },
                conflict=[t.repertoires.c.id],
                update_cols=(
                    "name", "color", "root_fen", "root_node_id", "main_engine",
                    "human_model", "branch_depth", "opponent_branch_threshold",
                    "sub_branch_threshold", "max_total_nodes", "max_line_length",
                    "notes", "tags_json", "is_active", "updated_at",
                ),
                # Never let a re-save reassign an existing owner; only fill a gap.
                coalesce_cols=("user_profile_id",),
            )

            for node in self._walk_nodes(repertoire.root_node):
                self._save_opening_node(conn, node)

    def load_repertoire(
        self, repertoire_id: str, owner_user_id: Optional[str] = None
    ) -> Optional[Repertoire]:
        with self.engine.connect() as conn:
            rep_row = conn.execute(
                select(t.repertoires).where(t.repertoires.c.id == repertoire_id)
            ).mappings().first()
            if rep_row is None:
                return None
            # Ownership gate: a repertoire owned by someone else is not-found to this owner.
            if owner_user_id is not None and rep_row["user_profile_id"] != owner_user_id:
                return None

            node_rows = conn.execute(
                select(t.opening_nodes).where(t.opening_nodes.c.repertoire_id == repertoire_id)
            ).mappings().all()

            nodes: Dict[str, OpeningNode] = {}
            for row in node_rows:
                move = self._load_move_by_id(conn, row["move_id"]) if row["move_id"] else None
                evaluation = (
                    self._load_engine_evaluation(conn, row["engine_evaluation_id"])
                    if row["engine_evaluation_id"]
                    else None
                )
                nodes[row["id"]] = OpeningNode(
                    id=row["id"],
                    repertoire_id=row["repertoire_id"],
                    parent_id=row["parent_id"],
                    move=move,
                    fen=row["fen"],
                    side_to_move=Color(row["side_to_move"]),
                    engine_evaluation=evaluation,
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

        for node in nodes.values():
            if node.parent_id and node.parent_id in nodes:
                nodes[node.parent_id].children.append(node)

        root_node_id = rep_row["root_node_id"]
        root_node = nodes.get(root_node_id)
        if root_node is None:
            root_node = next((node for node in nodes.values() if node.parent_id is None), None)
        if root_node is None:
            return None

        return Repertoire(
            id=rep_row["id"],
            name=rep_row["name"],
            color=Color(rep_row["color"]),
            root_fen=rep_row["root_fen"],
            root_node=root_node,
            main_engine=rep_row["main_engine"],
            human_model=rep_row["human_model"],
            branch_depth=rep_row["branch_depth"],
            opponent_branch_threshold=rep_row["opponent_branch_threshold"],
            sub_branch_threshold=rep_row["sub_branch_threshold"],
            max_total_nodes=rep_row["max_total_nodes"],
            max_line_length=rep_row["max_line_length"],
            notes=rep_row["notes"],
            tags=_json_load(rep_row["tags_json"], []),
            is_active=_int_to_bool(rep_row["is_active"]),
        )

    def list_repertoires(self, owner_user_id: Optional[str] = None) -> List[Repertoire]:
        stmt = select(t.repertoires.c.id).order_by(t.repertoires.c.updated_at.desc())
        if owner_user_id is not None:
            stmt = stmt.where(t.repertoires.c.user_profile_id == owner_user_id)
        with self.engine.connect() as conn:
            ids = [row["id"] for row in conn.execute(stmt).mappings().all()]
        return [
            repertoire
            for repertoire in (self.load_repertoire(rep_id) for rep_id in ids)
            if repertoire is not None
        ]

    def count_repertoires(self, owner_user_id: Optional[str] = None) -> int:
        """Number of repertoires owned by ``owner_user_id`` (all rows if None),
        without loading any opening trees — used by the Free-plan quota gate."""
        stmt = select(func.count()).select_from(t.repertoires)
        if owner_user_id is not None:
            stmt = stmt.where(t.repertoires.c.user_profile_id == owner_user_id)
        with self.engine.connect() as conn:
            return int(conn.execute(stmt).scalar_one())

    def repertoire_meta(self, repertoire_id: str) -> Optional[Dict[str, Any]]:
        """Lightweight ``(id, name, is_active, owner_user_id)`` for owner-gating and
        write responses, without loading the whole opening tree. ``None`` if absent;
        ``owner_user_id`` is ``None`` for an unclaimed/legacy row."""
        with self.engine.connect() as conn:
            row = conn.execute(
                select(
                    t.repertoires.c.id,
                    t.repertoires.c.name,
                    t.repertoires.c.is_active,
                    t.repertoires.c.user_profile_id,
                ).where(t.repertoires.c.id == repertoire_id)
            ).mappings().first()
        if row is None:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "is_active": _int_to_bool(row["is_active"]),
            "owner_user_id": row["user_profile_id"],
        }

    def set_repertoire_active(self, repertoire_id: str, active: bool) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .values(is_active=_bool_to_int(active), updated_at=_now_text())
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
                    t.repertoires.c.user_profile_id.is_(None),
                )
                .values(user_profile_id=owner_user_id)
            )

    def claim_or_verify_game(self, game_id: str, owner_user_id: str) -> bool:
        """Stamp ownership on an unowned game (first writer wins) and report whether
        the caller may access it. Returns ``False`` when the game is missing or owned
        by a *different* user — the caller treats that as not-found (don't reveal
        another owner's game). Mirrors the legacy server's ``_claim_or_verify_game``."""
        with self.engine.begin() as conn:
            conn.execute(
                update(t.games)
                .where(t.games.c.id == game_id, t.games.c.owner_user_id.is_(None))
                .values(owner_user_id=owner_user_id)
            )
            row = conn.execute(
                select(t.games.c.owner_user_id).where(t.games.c.id == game_id)
            ).mappings().first()
        return row is not None and row["owner_user_id"] == owner_user_id

    def delete_repertoire(self, repertoire_id: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(delete(t.repertoires).where(t.repertoires.c.id == repertoire_id))

    def delete_opening_nodes(self, repertoire_id: str, node_ids: List[str]) -> None:
        if not node_ids:
            return
        with self.engine.begin() as conn:
            # Clear references that don't cascade, otherwise the node delete trips
            # a FOREIGN KEY constraint (e.g. a live training session still points
            # at one of these nodes via current_node_id).
            conn.execute(
                update(t.training_sessions)
                .where(t.training_sessions.c.current_node_id.in_(node_ids))
                .values(current_node_id=None)
            )
            conn.execute(
                update(t.practical_opening_matches)
                .where(t.practical_opening_matches.c.last_matched_node_id.in_(node_ids))
                .values(last_matched_node_id=None)
            )
            conn.execute(
                delete(t.generation_runs).where(t.generation_runs.c.root_node_id.in_(node_ids))
            )
            conn.execute(
                delete(t.opening_nodes).where(
                    t.opening_nodes.c.repertoire_id == repertoire_id,
                    t.opening_nodes.c.id.in_(node_ids),
                )
            )

    def save_training_session(self, session: TrainingSession) -> None:
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.training_sessions,
                {
                    "id": session.id,
                    "repertoire_id": session.repertoire_id,
                    "mode": session.mode.value,
                    "line_order_json": _json_dump(session.line_order),
                    "current_index": session.current_index,
                    "current_node_id": session.current_node_id,
                    "mistakes_json": _json_dump(session.mistakes),
                    "mastered_nodes_json": _json_dump(session.mastered_nodes),
                    "seed": session.seed,
                    "created_at": _dt_to_text(session.created_at),
                    "updated_at": _dt_to_text(session.updated_at),
                },
                conflict=[t.training_sessions.c.id],
                update_cols=(
                    "repertoire_id", "mode", "line_order_json", "current_index",
                    "current_node_id", "mistakes_json", "mastered_nodes_json", "seed",
                    "updated_at",
                ),
            )

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

    def save_training_progress(
        self,
        repertoire_id: str,
        progress: TrainingProgress,
        *,
        user_profile_id: Optional[str] = None,
    ) -> None:
        progress_id = self._training_progress_id(user_profile_id, repertoire_id, progress.node_id)
        now = _now_text()
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.training_progress,
                {
                    "id": progress_id,
                    "user_profile_id": user_profile_id,
                    "repertoire_id": repertoire_id,
                    "node_id": progress.node_id,
                    "attempts": progress.attempts,
                    "correct_attempts": progress.correct_attempts,
                    "last_reviewed_at": _dt_to_text(progress.last_reviewed_at),
                    "spaced_repetition_score": progress.spaced_repetition_score,
                    "due_at": _dt_to_text(progress.due_at),
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

    def load_training_progress(
        self,
        repertoire_id: str,
        node_id: str,
        *,
        user_profile_id: Optional[str] = None,
    ) -> Optional[TrainingProgress]:
        progress_id = self._training_progress_id(user_profile_id, repertoire_id, node_id)
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.training_progress).where(t.training_progress.c.id == progress_id)
            ).mappings().first()
        if row is None:
            return None
        return self._training_progress_from_row(row)

    def existing_move_signature_ids(
        self, owner_user_id: Optional[str] = None
    ) -> Dict[str, str]:
        """Map each stored game's UCI move-sequence signature to its game id, so a
        re-imported game (no lichess id) is detected as a duplicate AND resolved
        back to the already-stored game rather than a fresh, unsaved candidate.

        Owner-scoped: when an owner is supplied only that owner's games are
        considered, so one user pasting a PGN another user already stored gets their
        own owned copy rather than being bounced to the other user's game."""
        if owner_user_id is None:
            stmt = (
                select(t.moves.c.game_id, t.moves.c.uci)
                .where(t.moves.c.game_id.is_not(None))
                .order_by(t.moves.c.game_id, t.moves.c.ply)
            )
        else:
            stmt = (
                select(t.moves.c.game_id, t.moves.c.uci)
                .select_from(t.moves.join(t.games, t.games.c.id == t.moves.c.game_id))
                .where(t.games.c.owner_user_id == owner_user_id)
                .order_by(t.moves.c.game_id, t.moves.c.ply)
            )
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        by_game: Dict[str, List[str]] = {}
        for row in rows:
            by_game.setdefault(row["game_id"], []).append(row["uci"])
        signatures: Dict[str, str] = {}
        for game_id, moves in by_game.items():
            if not moves:
                continue
            # Keep the first game id seen for a signature (stable across calls).
            signatures.setdefault(" ".join(moves), game_id)
        return signatures

    def list_training_progress(
        self,
        repertoire_id: str,
        *,
        user_profile_id: Optional[str] = None,
    ) -> List[TrainingProgress]:
        """All stored progress rows for a repertoire (for heatmap / due queue)."""
        tp = t.training_progress
        if user_profile_id is None:
            owner_cond = tp.c.user_profile_id.is_(None)
        else:
            owner_cond = tp.c.user_profile_id == user_profile_id
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(tp).where(tp.c.repertoire_id == repertoire_id, owner_cond)
            ).mappings().all()
        return [self._training_progress_from_row(row) for row in rows]

    def save_analysis_result(self, result: AnalysisResult) -> None:
        analysis_id = self._analysis_result_id(result)
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.analysis_results,
                {
                    "id": analysis_id,
                    "game_id": result.game_id,
                    "analyzed_at": _dt_to_text(result.analyzed_at),
                    "engine": result.engine,
                    "depth": result.depth,
                    "summary_json": _json_dump(result.summary),
                    "critical_ply_json": _json_dump(result.critical_ply),
                    "config_json": _json_dump({}),
                },
                conflict=[t.analysis_results.c.id],
                update_cols=(
                    "analyzed_at", "engine", "depth", "summary_json",
                    "critical_ply_json", "config_json",
                ),
            )

    def list_analyzed_games(self, owner_user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Metadata for every game that has a saved analysis (latest per game),
        newest first — powers the Analyze "History" list. Analyses are owned
        transitively through their game, so scoping joins on ``games.owner_user_id``."""
        ar = t.analysis_results
        g = t.games
        latest = (
            select(
                ar.c.game_id.label("game_id"),
                func.max(ar.c.analyzed_at).label("max_at"),
            )
            .group_by(ar.c.game_id)
            .subquery()
        )
        stmt = (
            select(
                ar.c.game_id.label("game_id"),
                ar.c.analyzed_at.label("analyzed_at"),
                ar.c.engine.label("engine"),
                ar.c.depth.label("depth"),
                ar.c.summary_json.label("summary_json"),
                g.c.white.label("white"),
                g.c.black.label("black"),
                g.c.result.label("result"),
                g.c.played_at.label("played_at"),
                g.c.lichess_id.label("lichess_id"),
            )
            .select_from(
                ar.join(g, g.c.id == ar.c.game_id).join(
                    latest,
                    (latest.c.game_id == ar.c.game_id) & (latest.c.max_at == ar.c.analyzed_at),
                )
            )
            .order_by(ar.c.analyzed_at.desc())
        )
        if owner_user_id is not None:
            stmt = stmt.where(g.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        return [
            {
                "game_id": row["game_id"],
                "analyzed_at": row["analyzed_at"],
                "engine": row["engine"],
                "depth": row["depth"],
                "summary": _json_load(row["summary_json"], {}),
                "white": row["white"],
                "black": row["black"],
                "result": row["result"],
                "played_at": row["played_at"],
                "lichess_id": row["lichess_id"],
            }
            for row in rows
        ]

    def load_latest_analysis_result(
        self, game_id: str, owner_user_id: Optional[str] = None
    ) -> Optional[AnalysisResult]:
        with self.engine.connect() as conn:
            # The analysis is owned through its game; gate on the game's owner first.
            if owner_user_id is not None:
                game_row = conn.execute(
                    select(t.games.c.owner_user_id).where(t.games.c.id == game_id)
                ).mappings().first()
                if game_row is None or game_row["owner_user_id"] != owner_user_id:
                    return None
            row = conn.execute(
                select(t.analysis_results)
                .where(t.analysis_results.c.game_id == game_id)
                .order_by(t.analysis_results.c.analyzed_at.desc())
                .limit(1)
            ).mappings().first()
        if row is None:
            return None

        game = self.load_game(game_id)
        return AnalysisResult(
            game_id=row["game_id"],
            analyzed_at=_dt_from_text(row["analyzed_at"]) or datetime.now(timezone.utc),
            engine=row["engine"],
            depth=row["depth"],
            move_results=game.moves if game is not None else [],
            summary=_json_load(row["summary_json"], {}),
            critical_ply=_json_load(row["critical_ply_json"], []),
        )

    def _save_move(
        self, conn: Connection, *, move: MoveRecord, move_id: str, game_id: Optional[str]
    ) -> None:
        now = _now_text()
        engine_eval_before_id = self._save_engine_evaluation(
            conn, move.engine_eval_before, move.fen_before
        )
        engine_eval_after_id = self._save_engine_evaluation(
            conn, move.engine_eval_after, move.fen_after
        )
        best_move_eval_id = self._save_engine_evaluation(
            conn, move.best_move_eval, move.fen_before
        )

        _upsert(
            conn,
            t.moves,
            {
                "id": move_id,
                "game_id": game_id,
                "ply": move.ply,
                "move_number": move.move_number,
                "side_to_move": move.side_to_move.value,
                "uci": move.uci,
                "san": move.san,
                "fen_before": move.fen_before,
                "fen_after": move.fen_after,
                "engine_eval_before_id": engine_eval_before_id,
                "engine_eval_after_id": engine_eval_after_id,
                "best_move_uci": move.best_move_uci,
                "best_move_eval_id": best_move_eval_id,
                "classification": move.classification.value,
                "comment": move.comment,
                "tags_json": _json_dump(move.tags),
                "source": move.source.value,
                "created_at": now,
            },
            conflict=[t.moves.c.id],
            update_cols=(
                "game_id", "ply", "move_number", "side_to_move", "uci", "san",
                "fen_before", "fen_after", "engine_eval_before_id",
                "engine_eval_after_id", "best_move_uci", "best_move_eval_id",
                "classification", "comment", "tags_json", "source",
            ),
        )

    def _save_opening_node(self, conn: Connection, node: OpeningNode) -> None:
        now = _now_text()
        move_id = None
        if node.move is not None:
            move_id = self._opening_move_id(node.id)
            self._save_move(conn, move=node.move, move_id=move_id, game_id=None)

        engine_evaluation_id = self._save_engine_evaluation(conn, node.engine_evaluation, node.fen)

        _upsert(
            conn,
            t.opening_nodes,
            {
                "id": node.id,
                "repertoire_id": node.repertoire_id,
                "parent_id": node.parent_id,
                "move_id": move_id,
                "fen": node.fen,
                "side_to_move": node.side_to_move.value,
                "engine_evaluation_id": engine_evaluation_id,
                "maia_probability": node.maia_probability,
                "is_mainline": _bool_to_int(node.is_mainline),
                "is_user_prepared_move": _bool_to_int(node.is_user_prepared_move),
                "is_enabled": _bool_to_int(node.is_enabled),
                "priority": node.priority,
                "comment": node.comment,
                "tags_json": _json_dump(node.tags),
                "arrows_json": _json_dump(node.arrows),
                "circles_json": _json_dump(node.circles),
                "tactical_warning": node.tactical_warning,
                "strategic_idea": node.strategic_idea,
                "typical_plan": node.typical_plan,
                "source": node.source.value,
                "created_at": now,
                "updated_at": now,
            },
            conflict=[t.opening_nodes.c.id],
            update_cols=(
                "repertoire_id", "parent_id", "move_id", "fen", "side_to_move",
                "engine_evaluation_id", "maia_probability", "is_mainline",
                "is_user_prepared_move", "is_enabled", "priority", "comment",
                "tags_json", "arrows_json", "circles_json", "tactical_warning",
                "strategic_idea", "typical_plan", "source", "updated_at",
            ),
        )

    def _save_engine_evaluation(
        self,
        conn: Connection,
        evaluation: Optional[EngineEvaluation],
        fen: str,
    ) -> Optional[str]:
        if evaluation is None:
            return None

        evaluation_id = self._engine_evaluation_id(fen, evaluation)
        now = _now_text()
        _upsert(
            conn,
            t.engine_evaluations,
            {
                "id": evaluation_id,
                "fen": fen,
                "engine": evaluation.engine,
                "depth": evaluation.depth,
                "nodes": evaluation.nodes,
                "time_ms": evaluation.time_ms,
                "score_cp": evaluation.score_cp,
                "mate_in": evaluation.mate_in,
                "best_move_uci": evaluation.best_move_uci,
                "pv_json": _json_dump(evaluation.pv),
                "wdl_json": _json_dump(evaluation.wdl) if evaluation.wdl is not None else None,
                "created_at": now,
            },
            conflict=[t.engine_evaluations.c.id],
            update_cols=(
                "engine", "depth", "nodes", "time_ms", "score_cp", "mate_in",
                "best_move_uci", "pv_json", "wdl_json",
            ),
        )
        return evaluation_id

    def _load_move_by_id(self, conn: Connection, move_id: str) -> Optional[MoveRecord]:
        row = conn.execute(
            select(t.moves).where(t.moves.c.id == move_id)
        ).mappings().first()
        return self._move_from_row(conn, row) if row is not None else None

    def _move_from_row(self, conn: Connection, row: Mapping[str, Any]) -> MoveRecord:
        return MoveRecord(
            uci=row["uci"],
            san=row["san"],
            fen_before=row["fen_before"],
            fen_after=row["fen_after"],
            move_number=row["move_number"],
            ply=row["ply"],
            side_to_move=Color(row["side_to_move"]),
            source=MoveSource(row["source"]),
            engine_eval_before=self._load_engine_evaluation(conn, row["engine_eval_before_id"])
            if row["engine_eval_before_id"]
            else None,
            engine_eval_after=self._load_engine_evaluation(conn, row["engine_eval_after_id"])
            if row["engine_eval_after_id"]
            else None,
            best_move_uci=row["best_move_uci"],
            best_move_eval=self._load_engine_evaluation(conn, row["best_move_eval_id"])
            if row["best_move_eval_id"]
            else None,
            classification=MoveClassification(row["classification"]),
            comment=row["comment"],
            tags=_json_load(row["tags_json"], []),
        )

    def _load_engine_evaluation(
        self, conn: Connection, evaluation_id: str
    ) -> Optional[EngineEvaluation]:
        row = conn.execute(
            select(t.engine_evaluations).where(t.engine_evaluations.c.id == evaluation_id)
        ).mappings().first()
        if row is None:
            return None

        return EngineEvaluation(
            engine=row["engine"],
            depth=row["depth"],
            nodes=row["nodes"],
            time_ms=row["time_ms"],
            score_cp=row["score_cp"],
            mate_in=row["mate_in"],
            best_move_uci=row["best_move_uci"],
            pv=_json_load(row["pv_json"], []),
            wdl=_json_load(row["wdl_json"], None),
        )

    def _training_session_from_row(self, row: Mapping[str, Any]) -> TrainingSession:
        created_at = _dt_from_text(row["created_at"]) or datetime.now(timezone.utc)
        updated_at = _dt_from_text(row["updated_at"]) or created_at
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
        )

    def _training_progress_from_row(self, row: Mapping[str, Any]) -> TrainingProgress:
        return TrainingProgress(
            node_id=row["node_id"],
            attempts=row["attempts"],
            correct_attempts=row["correct_attempts"],
            last_reviewed_at=_dt_from_text(row["last_reviewed_at"]),
            spaced_repetition_score=row["spaced_repetition_score"],
            due_at=_dt_from_text(row["due_at"]),
            is_mastered=_int_to_bool(row["is_mastered"]),
        )

    def _walk_nodes(self, root: OpeningNode) -> Iterable[OpeningNode]:
        yield root
        for child in root.children:
            for node in self._walk_nodes(child):
                yield node

    def _game_move_id(self, game_id: str, ply: int) -> str:
        return "game:{0}:{1}".format(game_id, ply)

    def _opening_move_id(self, node_id: str) -> str:
        return "opening:{0}:move".format(node_id)

    def _engine_evaluation_id(self, fen: str, evaluation: EngineEvaluation) -> str:
        payload = {
            "fen": fen,
            "engine": evaluation.engine,
            "depth": evaluation.depth,
            "nodes": evaluation.nodes,
            "time_ms": evaluation.time_ms,
            "score_cp": evaluation.score_cp,
            "mate_in": evaluation.mate_in,
            "best_move_uci": evaluation.best_move_uci,
            "pv": evaluation.pv,
            "wdl": evaluation.wdl,
        }
        digest = sha256(_json_dump(payload).encode("utf-8")).hexdigest()[:32]
        return "eval:{0}".format(digest)

    def _analysis_result_id(self, result: AnalysisResult) -> str:
        payload = {
            "game_id": result.game_id,
            "analyzed_at": _dt_to_text(result.analyzed_at),
            "engine": result.engine,
            "depth": result.depth,
        }
        digest = sha256(_json_dump(payload).encode("utf-8")).hexdigest()[:32]
        return "analysis:{0}".format(digest)

    def _training_progress_id(
        self,
        user_profile_id: Optional[str],
        repertoire_id: str,
        node_id: str,
    ) -> str:
        payload = {
            "user_profile_id": user_profile_id or "default",
            "repertoire_id": repertoire_id,
            "node_id": node_id,
        }
        digest = sha256(_json_dump(payload).encode("utf-8")).hexdigest()[:32]
        return "training-progress:{0}".format(digest)

    def new_id(self) -> str:
        return str(uuid.uuid4())
