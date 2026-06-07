from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Dict, Iterable, List, Optional

import sqlite3

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


class PrepForgeRepository:
    """SQLite persistence for shared domain models.

    The repository is intentionally narrow: it stores and loads domain objects
    without putting analysis, training, or generation decisions into SQL code.
    """

    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

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
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO user_profiles (id, display_name, lichess_username, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (profile_id, display_name, lichess_username, now, now),
            )
        return profile_id

    def session_user(self, token_hash: str) -> Optional[str]:
        """Return the user_profile_id for a session token hash (and touch last_seen)."""
        row = self.connection.execute(
            "SELECT user_profile_id FROM user_sessions WHERE token_hash = ?",
            (token_hash,),
        ).fetchone()
        if row is None:
            return None
        with self.connection:
            self.connection.execute(
                "UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?",
                (_now_text(), token_hash),
            )
        return row["user_profile_id"]

    def create_guest_session(self, token_hash: str) -> str:
        """Mint a fresh guest profile + session for a new browser. Returns the profile id."""
        profile_id = self.create_user_profile(display_name="Guest")
        now = _now_text()
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO user_sessions (token_hash, user_profile_id, created_at, last_seen_at)
                VALUES (?, ?, ?, ?)
                """,
                (token_hash, profile_id, now, now),
            )
        return profile_id

    def rebind_session(self, token_hash: str, user_profile_id: str) -> None:
        """Point an existing session at a different profile (e.g. guest → Lichess account)."""
        with self.connection:
            self.connection.execute(
                "UPDATE user_sessions SET user_profile_id = ?, last_seen_at = ? WHERE token_hash = ?",
                (user_profile_id, _now_text(), token_hash),
            )

    def delete_session(self, token_hash: str) -> None:
        """Drop a session row so its cookie can no longer authenticate (sign out). The
        underlying user_profile and its owned data are left intact."""
        with self.connection:
            self.connection.execute(
                "DELETE FROM user_sessions WHERE token_hash = ?",
                (token_hash,),
            )

    def find_profile_by_lichess(self, username: str) -> Optional[str]:
        row = self.connection.execute(
            "SELECT id FROM user_profiles WHERE lichess_username = ? COLLATE NOCASE",
            (username,),
        ).fetchone()
        return row["id"] if row is not None else None

    def ensure_lichess_profile(self, username: str) -> str:
        existing = self.find_profile_by_lichess(username)
        if existing is not None:
            return existing
        return self.create_user_profile(display_name=username, lichess_username=username)

    def profile_lichess_username(self, profile_id: str) -> Optional[str]:
        row = self.connection.execute(
            "SELECT lichess_username FROM user_profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
        return row["lichess_username"] if row is not None else None

    def get_profile_setting(
        self, profile_id: str, key: str, default: Any = None
    ) -> Any:
        """Read one key from a profile's ``settings_json`` blob (per-user state such
        as the Lichess OAuth token). Unknown profile/key returns ``default``."""
        row = self.connection.execute(
            "SELECT settings_json FROM user_profiles WHERE id = ?",
            (profile_id,),
        ).fetchone()
        if row is None:
            return default
        data = _json_load(row["settings_json"], {})
        return data.get(key, default) if isinstance(data, dict) else default

    def set_profile_setting(self, profile_id: str, key: str, value: Any) -> None:
        """Upsert one key into a profile's ``settings_json`` (per-user state). A
        ``None`` value deletes the key. Raises if the profile does not exist so a
        token can never be written to a phantom owner."""
        with self.connection:
            row = self.connection.execute(
                "SELECT settings_json FROM user_profiles WHERE id = ?",
                (profile_id,),
            ).fetchone()
            if row is None:
                raise ValueError("unknown profile: {0}".format(profile_id))
            data = _json_load(row["settings_json"], {})
            if not isinstance(data, dict):
                data = {}
            if value is None:
                data.pop(key, None)
            else:
                data[key] = value
            self.connection.execute(
                "UPDATE user_profiles SET settings_json = ?, updated_at = ? WHERE id = ?",
                (_json_dump(data), _now_text(), profile_id),
            )

    def reassign_owner(self, from_user_id: str, to_user_id: str) -> None:
        """Move every owned top-level row from one profile to another (guest → account)."""
        if from_user_id == to_user_id:
            return
        with self.connection:
            self.connection.execute(
                "UPDATE games SET owner_user_id = ? WHERE owner_user_id = ?",
                (to_user_id, from_user_id),
            )
            self.connection.execute(
                "UPDATE repertoires SET user_profile_id = ? WHERE user_profile_id = ?",
                (to_user_id, from_user_id),
            )

    def save_game(self, game: Game, owner_user_id: Optional[str] = None) -> None:
        now = _now_text()
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO games (
                    id, source, initial_fen, white, black, result, event, site,
                    played_at, pgn, lichess_id, tags_json, owner_user_id,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    source = excluded.source,
                    initial_fen = excluded.initial_fen,
                    white = excluded.white,
                    black = excluded.black,
                    result = excluded.result,
                    event = excluded.event,
                    site = excluded.site,
                    played_at = excluded.played_at,
                    pgn = excluded.pgn,
                    lichess_id = excluded.lichess_id,
                    tags_json = excluded.tags_json,
                    -- Never let a re-save reassign an existing owner; only fill a gap.
                    owner_user_id = COALESCE(games.owner_user_id, excluded.owner_user_id),
                    updated_at = excluded.updated_at
                """,
                (
                    game.id,
                    game.source.value,
                    game.initial_fen,
                    game.white,
                    game.black,
                    game.result.value,
                    game.event,
                    game.site,
                    _dt_to_text(game.played_at),
                    game.pgn,
                    game.lichess_id,
                    _json_dump(game.tags),
                    owner_user_id,
                    now,
                    now,
                ),
            )

            for move in game.moves:
                self._save_move(
                    move=move,
                    move_id=self._game_move_id(game.id, move.ply),
                    game_id=game.id,
                )

    def load_game(self, game_id: str, owner_user_id: Optional[str] = None) -> Optional[Game]:
        row = self.connection.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
        if row is None:
            return None
        # Ownership gate: when an owner is supplied, a game owned by someone else is
        # treated as not-found (no IDOR via a guessed/known id).
        if owner_user_id is not None and row["owner_user_id"] != owner_user_id:
            return None

        moves = [
            self._move_from_row(move_row)
            for move_row in self.connection.execute(
                "SELECT * FROM moves WHERE game_id = ? ORDER BY ply",
                (game_id,),
            ).fetchall()
        ]

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
        if owner_user_id is None:
            row = self.connection.execute(
                "SELECT id FROM games WHERE lichess_id = ?",
                (lichess_id,),
            ).fetchone()
        else:
            row = self.connection.execute(
                "SELECT id FROM games WHERE lichess_id = ? AND owner_user_id = ?",
                (lichess_id, owner_user_id),
            ).fetchone()
        return row["id"] if row is not None else None

    def has_game(self, game_id: str) -> bool:
        row = self.connection.execute("SELECT 1 FROM games WHERE id = ?", (game_id,)).fetchone()
        return row is not None

    def list_games(self, owner_user_id: Optional[str] = None) -> List[Game]:
        if owner_user_id is None:
            rows = self.connection.execute(
                "SELECT id FROM games ORDER BY created_at DESC"
            ).fetchall()
        else:
            rows = self.connection.execute(
                "SELECT id FROM games WHERE owner_user_id = ? ORDER BY created_at DESC",
                (owner_user_id,),
            ).fetchall()
        return [game for game in (self.load_game(row["id"]) for row in rows) if game is not None]

    def save_repertoire(self, repertoire: Repertoire, owner_user_id: Optional[str] = None) -> None:
        now = _now_text()
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO repertoires (
                    id, user_profile_id, name, color, root_fen, root_node_id, main_engine,
                    human_model, branch_depth, opponent_branch_threshold,
                    sub_branch_threshold, max_total_nodes, max_line_length,
                    notes, tags_json, is_active, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    color = excluded.color,
                    root_fen = excluded.root_fen,
                    root_node_id = excluded.root_node_id,
                    main_engine = excluded.main_engine,
                    human_model = excluded.human_model,
                    branch_depth = excluded.branch_depth,
                    opponent_branch_threshold = excluded.opponent_branch_threshold,
                    sub_branch_threshold = excluded.sub_branch_threshold,
                    max_total_nodes = excluded.max_total_nodes,
                    max_line_length = excluded.max_line_length,
                    notes = excluded.notes,
                    tags_json = excluded.tags_json,
                    is_active = excluded.is_active,
                    -- Never let a re-save reassign an existing owner; only fill a gap.
                    user_profile_id = COALESCE(repertoires.user_profile_id, excluded.user_profile_id),
                    updated_at = excluded.updated_at
                """,
                (
                    repertoire.id,
                    owner_user_id,
                    repertoire.name,
                    repertoire.color.value,
                    repertoire.root_fen,
                    repertoire.root_node.id,
                    repertoire.main_engine,
                    repertoire.human_model,
                    repertoire.branch_depth,
                    repertoire.opponent_branch_threshold,
                    repertoire.sub_branch_threshold,
                    repertoire.max_total_nodes,
                    repertoire.max_line_length,
                    repertoire.notes,
                    _json_dump(repertoire.tags),
                    1 if getattr(repertoire, "is_active", True) else 0,
                    now,
                    now,
                ),
            )

            for node in self._walk_nodes(repertoire.root_node):
                self._save_opening_node(node)

    def load_repertoire(
        self, repertoire_id: str, owner_user_id: Optional[str] = None
    ) -> Optional[Repertoire]:
        rep_row = self.connection.execute(
            "SELECT * FROM repertoires WHERE id = ?",
            (repertoire_id,),
        ).fetchone()
        if rep_row is None:
            return None
        # Ownership gate: a repertoire owned by someone else is not-found to this owner.
        if owner_user_id is not None and rep_row["user_profile_id"] != owner_user_id:
            return None

        node_rows = self.connection.execute(
            "SELECT * FROM opening_nodes WHERE repertoire_id = ?",
            (repertoire_id,),
        ).fetchall()

        nodes: Dict[str, OpeningNode] = {}
        for row in node_rows:
            move = self._load_move_by_id(row["move_id"]) if row["move_id"] else None
            evaluation = (
                self._load_engine_evaluation(row["engine_evaluation_id"])
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
                arrows=_json_load(
                    row["arrows_json"] if "arrows_json" in row.keys() else None, []
                ),
                circles=_json_load(
                    row["circles_json"] if "circles_json" in row.keys() else None, []
                ),
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
            is_active=_int_to_bool(
                rep_row["is_active"] if "is_active" in rep_row.keys() else 1
            ),
        )

    def list_repertoires(self, owner_user_id: Optional[str] = None) -> List[Repertoire]:
        if owner_user_id is None:
            rows = self.connection.execute(
                "SELECT id FROM repertoires ORDER BY updated_at DESC"
            ).fetchall()
        else:
            rows = self.connection.execute(
                "SELECT id FROM repertoires WHERE user_profile_id = ? ORDER BY updated_at DESC",
                (owner_user_id,),
            ).fetchall()
        return [
            repertoire
            for repertoire in (self.load_repertoire(row["id"]) for row in rows)
            if repertoire is not None
        ]

    def delete_repertoire(self, repertoire_id: str) -> None:
        with self.connection:
            self.connection.execute("DELETE FROM repertoires WHERE id = ?", (repertoire_id,))

    def delete_opening_nodes(self, repertoire_id: str, node_ids: List[str]) -> None:
        if not node_ids:
            return
        placeholders = ",".join("?" for _ in node_ids)
        with self.connection:
            # Clear references that don't cascade, otherwise the node delete trips
            # a FOREIGN KEY constraint (e.g. a live training session still points
            # at one of these nodes via current_node_id).
            self.connection.execute(
                "UPDATE training_sessions SET current_node_id = NULL "
                "WHERE current_node_id IN ({0})".format(placeholders),
                node_ids,
            )
            self.connection.execute(
                "UPDATE practical_opening_matches SET last_matched_node_id = NULL "
                "WHERE last_matched_node_id IN ({0})".format(placeholders),
                node_ids,
            )
            self.connection.execute(
                "DELETE FROM generation_runs WHERE root_node_id IN ({0})".format(placeholders),
                node_ids,
            )
            self.connection.execute(
                "DELETE FROM opening_nodes WHERE repertoire_id = ? AND id IN ({0})".format(
                    placeholders
                ),
                [repertoire_id, *node_ids],
            )

    def save_training_session(self, session: TrainingSession) -> None:
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO training_sessions (
                    id, repertoire_id, mode, line_order_json, current_index,
                    current_node_id, mistakes_json, mastered_nodes_json, seed,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    repertoire_id = excluded.repertoire_id,
                    mode = excluded.mode,
                    line_order_json = excluded.line_order_json,
                    current_index = excluded.current_index,
                    current_node_id = excluded.current_node_id,
                    mistakes_json = excluded.mistakes_json,
                    mastered_nodes_json = excluded.mastered_nodes_json,
                    seed = excluded.seed,
                    updated_at = excluded.updated_at
                """,
                (
                    session.id,
                    session.repertoire_id,
                    session.mode.value,
                    _json_dump(session.line_order),
                    session.current_index,
                    session.current_node_id,
                    _json_dump(session.mistakes),
                    _json_dump(session.mastered_nodes),
                    session.seed,
                    _dt_to_text(session.created_at),
                    _dt_to_text(session.updated_at),
                ),
            )

    def load_training_session(self, session_id: str) -> Optional[TrainingSession]:
        row = self.connection.execute(
            "SELECT * FROM training_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        return self._training_session_from_row(row) if row is not None else None

    def load_latest_training_session(
        self,
        repertoire_id: str,
        mode: Optional[TrainingMode] = None,
    ) -> Optional[TrainingSession]:
        if mode is None:
            row = self.connection.execute(
                """
                SELECT * FROM training_sessions
                WHERE repertoire_id = ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (repertoire_id,),
            ).fetchone()
        else:
            row = self.connection.execute(
                """
                SELECT * FROM training_sessions
                WHERE repertoire_id = ? AND mode = ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (repertoire_id, mode.value),
            ).fetchone()
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
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO training_progress (
                    id, user_profile_id, repertoire_id, node_id, attempts,
                    correct_attempts, last_reviewed_at, spaced_repetition_score,
                    due_at, is_mastered, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    attempts = excluded.attempts,
                    correct_attempts = excluded.correct_attempts,
                    last_reviewed_at = excluded.last_reviewed_at,
                    spaced_repetition_score = excluded.spaced_repetition_score,
                    due_at = excluded.due_at,
                    is_mastered = excluded.is_mastered,
                    updated_at = excluded.updated_at
                """,
                (
                    progress_id,
                    user_profile_id,
                    repertoire_id,
                    progress.node_id,
                    progress.attempts,
                    progress.correct_attempts,
                    _dt_to_text(progress.last_reviewed_at),
                    progress.spaced_repetition_score,
                    _dt_to_text(progress.due_at),
                    _bool_to_int(progress.is_mastered),
                    now,
                    now,
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
        row = self.connection.execute(
            "SELECT * FROM training_progress WHERE id = ?",
            (progress_id,),
        ).fetchone()
        if row is None:
            return None
        return TrainingProgress(
            node_id=row["node_id"],
            attempts=row["attempts"],
            correct_attempts=row["correct_attempts"],
            last_reviewed_at=_dt_from_text(row["last_reviewed_at"]),
            spaced_repetition_score=row["spaced_repetition_score"],
            due_at=_dt_from_text(row["due_at"]),
            is_mastered=_int_to_bool(row["is_mastered"]),
        )

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
            rows = self.connection.execute(
                "SELECT game_id, uci FROM moves WHERE game_id IS NOT NULL ORDER BY game_id, ply"
            ).fetchall()
        else:
            rows = self.connection.execute(
                """
                SELECT m.game_id AS game_id, m.uci AS uci
                FROM moves m
                JOIN games g ON g.id = m.game_id
                WHERE g.owner_user_id = ?
                ORDER BY m.game_id, m.ply
                """,
                (owner_user_id,),
            ).fetchall()
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
        rows = self.connection.execute(
            """
            SELECT * FROM training_progress
            WHERE repertoire_id = ?
              AND (user_profile_id IS ? OR user_profile_id = ?)
            """,
            (repertoire_id, user_profile_id, user_profile_id),
        ).fetchall()
        return [
            TrainingProgress(
                node_id=row["node_id"],
                attempts=row["attempts"],
                correct_attempts=row["correct_attempts"],
                last_reviewed_at=_dt_from_text(row["last_reviewed_at"]),
                spaced_repetition_score=row["spaced_repetition_score"],
                due_at=_dt_from_text(row["due_at"]),
                is_mastered=_int_to_bool(row["is_mastered"]),
            )
            for row in rows
        ]

    def save_analysis_result(self, result: AnalysisResult) -> None:
        analysis_id = self._analysis_result_id(result)
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO analysis_results (
                    id, game_id, analyzed_at, engine, depth, summary_json,
                    critical_ply_json, config_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    analyzed_at = excluded.analyzed_at,
                    engine = excluded.engine,
                    depth = excluded.depth,
                    summary_json = excluded.summary_json,
                    critical_ply_json = excluded.critical_ply_json,
                    config_json = excluded.config_json
                """,
                (
                    analysis_id,
                    result.game_id,
                    _dt_to_text(result.analyzed_at),
                    result.engine,
                    result.depth,
                    _json_dump(result.summary),
                    _json_dump(result.critical_ply),
                    _json_dump({}),
                ),
            )

    def list_analyzed_games(self, owner_user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Metadata for every game that has a saved analysis (latest per game),
        newest first — powers the Analyze "History" list. Analyses are owned
        transitively through their game, so scoping joins on ``games.owner_user_id``."""
        owner_clause = "WHERE g.owner_user_id = ?" if owner_user_id is not None else ""
        params = (owner_user_id,) if owner_user_id is not None else ()
        rows = self.connection.execute(
            """
            SELECT a.game_id AS game_id, a.analyzed_at AS analyzed_at,
                   a.engine AS engine, a.depth AS depth, a.summary_json AS summary_json,
                   g.white AS white, g.black AS black, g.result AS result,
                   g.played_at AS played_at, g.lichess_id AS lichess_id
            FROM analysis_results a
            JOIN games g ON g.id = a.game_id
            JOIN (
                SELECT game_id, MAX(analyzed_at) AS max_at
                FROM analysis_results GROUP BY game_id
            ) latest
              ON latest.game_id = a.game_id AND latest.max_at = a.analyzed_at
            {0}
            ORDER BY a.analyzed_at DESC
            """.format(owner_clause),
            params,
        ).fetchall()
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
        # The analysis is owned through its game; gate on the game's owner first.
        if owner_user_id is not None:
            game_row = self.connection.execute(
                "SELECT owner_user_id FROM games WHERE id = ?", (game_id,)
            ).fetchone()
            if game_row is None or game_row["owner_user_id"] != owner_user_id:
                return None
        row = self.connection.execute(
            """
            SELECT * FROM analysis_results
            WHERE game_id = ?
            ORDER BY analyzed_at DESC
            LIMIT 1
            """,
            (game_id,),
        ).fetchone()
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

    def _save_move(self, *, move: MoveRecord, move_id: str, game_id: Optional[str]) -> None:
        now = _now_text()
        engine_eval_before_id = self._save_engine_evaluation(
            move.engine_eval_before,
            move.fen_before,
        )
        engine_eval_after_id = self._save_engine_evaluation(move.engine_eval_after, move.fen_after)
        best_move_eval_id = self._save_engine_evaluation(move.best_move_eval, move.fen_before)

        self.connection.execute(
            """
            INSERT INTO moves (
                id, game_id, ply, move_number, side_to_move, uci, san,
                fen_before, fen_after, engine_eval_before_id, engine_eval_after_id,
                best_move_uci, best_move_eval_id, classification, comment,
                tags_json, source, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                game_id = excluded.game_id,
                ply = excluded.ply,
                move_number = excluded.move_number,
                side_to_move = excluded.side_to_move,
                uci = excluded.uci,
                san = excluded.san,
                fen_before = excluded.fen_before,
                fen_after = excluded.fen_after,
                engine_eval_before_id = excluded.engine_eval_before_id,
                engine_eval_after_id = excluded.engine_eval_after_id,
                best_move_uci = excluded.best_move_uci,
                best_move_eval_id = excluded.best_move_eval_id,
                classification = excluded.classification,
                comment = excluded.comment,
                tags_json = excluded.tags_json,
                source = excluded.source
            """,
            (
                move_id,
                game_id,
                move.ply,
                move.move_number,
                move.side_to_move.value,
                move.uci,
                move.san,
                move.fen_before,
                move.fen_after,
                engine_eval_before_id,
                engine_eval_after_id,
                move.best_move_uci,
                best_move_eval_id,
                move.classification.value,
                move.comment,
                _json_dump(move.tags),
                move.source.value,
                now,
            ),
        )

    def _save_opening_node(self, node: OpeningNode) -> None:
        now = _now_text()
        move_id = None
        if node.move is not None:
            move_id = self._opening_move_id(node.id)
            self._save_move(move=node.move, move_id=move_id, game_id=None)

        engine_evaluation_id = self._save_engine_evaluation(node.engine_evaluation, node.fen)

        self.connection.execute(
            """
            INSERT INTO opening_nodes (
                id, repertoire_id, parent_id, move_id, fen, side_to_move,
                engine_evaluation_id, maia_probability, is_mainline,
                is_user_prepared_move, is_enabled, priority, comment, tags_json,
                arrows_json, circles_json,
                tactical_warning, strategic_idea, typical_plan, source,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                repertoire_id = excluded.repertoire_id,
                parent_id = excluded.parent_id,
                move_id = excluded.move_id,
                fen = excluded.fen,
                side_to_move = excluded.side_to_move,
                engine_evaluation_id = excluded.engine_evaluation_id,
                maia_probability = excluded.maia_probability,
                is_mainline = excluded.is_mainline,
                is_user_prepared_move = excluded.is_user_prepared_move,
                is_enabled = excluded.is_enabled,
                priority = excluded.priority,
                comment = excluded.comment,
                tags_json = excluded.tags_json,
                arrows_json = excluded.arrows_json,
                circles_json = excluded.circles_json,
                tactical_warning = excluded.tactical_warning,
                strategic_idea = excluded.strategic_idea,
                typical_plan = excluded.typical_plan,
                source = excluded.source,
                updated_at = excluded.updated_at
            """,
            (
                node.id,
                node.repertoire_id,
                node.parent_id,
                move_id,
                node.fen,
                node.side_to_move.value,
                engine_evaluation_id,
                node.maia_probability,
                _bool_to_int(node.is_mainline),
                _bool_to_int(node.is_user_prepared_move),
                _bool_to_int(node.is_enabled),
                node.priority,
                node.comment,
                _json_dump(node.tags),
                _json_dump(node.arrows),
                _json_dump(node.circles),
                node.tactical_warning,
                node.strategic_idea,
                node.typical_plan,
                node.source.value,
                now,
                now,
            ),
        )

    def _save_engine_evaluation(
        self,
        evaluation: Optional[EngineEvaluation],
        fen: str,
    ) -> Optional[str]:
        if evaluation is None:
            return None

        evaluation_id = self._engine_evaluation_id(fen, evaluation)
        now = _now_text()
        self.connection.execute(
            """
            INSERT INTO engine_evaluations (
                id, fen, engine, depth, nodes, time_ms, score_cp, mate_in,
                best_move_uci, pv_json, wdl_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                engine = excluded.engine,
                depth = excluded.depth,
                nodes = excluded.nodes,
                time_ms = excluded.time_ms,
                score_cp = excluded.score_cp,
                mate_in = excluded.mate_in,
                best_move_uci = excluded.best_move_uci,
                pv_json = excluded.pv_json,
                wdl_json = excluded.wdl_json
            """,
            (
                evaluation_id,
                fen,
                evaluation.engine,
                evaluation.depth,
                evaluation.nodes,
                evaluation.time_ms,
                evaluation.score_cp,
                evaluation.mate_in,
                evaluation.best_move_uci,
                _json_dump(evaluation.pv),
                _json_dump(evaluation.wdl) if evaluation.wdl is not None else None,
                now,
            ),
        )
        return evaluation_id

    def _load_move_by_id(self, move_id: str) -> Optional[MoveRecord]:
        row = self.connection.execute("SELECT * FROM moves WHERE id = ?", (move_id,)).fetchone()
        return self._move_from_row(row) if row is not None else None

    def _move_from_row(self, row: sqlite3.Row) -> MoveRecord:
        return MoveRecord(
            uci=row["uci"],
            san=row["san"],
            fen_before=row["fen_before"],
            fen_after=row["fen_after"],
            move_number=row["move_number"],
            ply=row["ply"],
            side_to_move=Color(row["side_to_move"]),
            source=MoveSource(row["source"]),
            engine_eval_before=self._load_engine_evaluation(row["engine_eval_before_id"])
            if row["engine_eval_before_id"]
            else None,
            engine_eval_after=self._load_engine_evaluation(row["engine_eval_after_id"])
            if row["engine_eval_after_id"]
            else None,
            best_move_uci=row["best_move_uci"],
            best_move_eval=self._load_engine_evaluation(row["best_move_eval_id"])
            if row["best_move_eval_id"]
            else None,
            classification=MoveClassification(row["classification"]),
            comment=row["comment"],
            tags=_json_load(row["tags_json"], []),
        )

    def _load_engine_evaluation(self, evaluation_id: str) -> Optional[EngineEvaluation]:
        row = self.connection.execute(
            "SELECT * FROM engine_evaluations WHERE id = ?",
            (evaluation_id,),
        ).fetchone()
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

    def _training_session_from_row(self, row: sqlite3.Row) -> TrainingSession:
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
