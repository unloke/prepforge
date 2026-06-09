"""Legacy domain schema, expressed as SQLAlchemy Core tables.

This is the Phase 2 migration target: the same 19 tables the raw-SQL
``schema.sql`` (+ the runtime ``_apply_migrations`` additions) create, but defined
as SQLAlchemy ``Table`` objects on the *shared* ``api.db.Base.metadata``. That
gives the whole application one ``MetaData`` and one Alembic history covering both
the new identity tables (``api/models.py``) and the legacy domain tables, so
Postgres DDL is generated rather than hand-rolled and the global ``request_lock``
single-connection design can be retired.

Faithful-port choices (deliberate, see ROADMAP Phase 2a-1):
* JSON blobs and ISO-8601 datetimes stay ``Text`` (``schema.sql`` stores them as
  TEXT and the repository round-trips them with ``_json_dump`` / ``_dt_to_text``).
  Keeping the types identical means the repository's serialization logic does not
  change when its backend is swapped in 2a-2. JSONB/TIMESTAMPTZ is a later refinement.
* Boolean flags stay ``Integer`` (0/1), matching ``_bool_to_int``.
* Defaults are supplied by the repository in Python, so columns are ``nullable``
  per ``schema.sql`` but carry no server defaults.

``tests/test_sa_tables.py`` guards against this drifting from ``schema.sql``.
"""
from __future__ import annotations

from sqlalchemy import (
    Column,
    Float,
    ForeignKey,
    Index,
    Integer,
    Table,
    Text,
    UniqueConstraint,
)

from prepforge_chess.api.db import Base

metadata = Base.metadata

user_profiles = Table(
    "user_profiles",
    metadata,
    Column("id", Text, primary_key=True),
    Column("display_name", Text, nullable=False),
    Column("lichess_username", Text),
    Column("preferred_engine", Text, nullable=False),
    Column("default_analysis_depth", Integer, nullable=False),
    Column("settings_json", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)

games = Table(
    "games",
    metadata,
    Column("id", Text, primary_key=True),
    Column("source", Text, nullable=False),
    Column("initial_fen", Text, nullable=False),
    Column("white", Text),
    Column("black", Text),
    Column("result", Text, nullable=False),
    Column("event", Text),
    Column("site", Text),
    Column("played_at", Text),
    Column("pgn", Text),
    # Not globally unique: dedup is per-owner (see idx_games_owner_lichess).
    Column("lichess_id", Text),
    Column("tags_json", Text, nullable=False),
    # Added by the multi-tenancy migration; isolation root for owned games.
    Column("owner_user_id", Text),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    Index("idx_games_owner", "owner_user_id"),
    # NULLs are distinct, so ownerless / non-Lichess rows are never constrained.
    Index("idx_games_owner_lichess", "owner_user_id", "lichess_id", unique=True),
)

positions = Table(
    "positions",
    metadata,
    Column("id", Text, primary_key=True),
    Column("fen", Text, nullable=False, unique=True),
    Column("side_to_move", Text, nullable=False),
    Column("move_number", Integer, nullable=False),
    Column("halfmove_clock", Integer, nullable=False),
    Column("fullmove_number", Integer, nullable=False),
    Column("legal_moves_json", Text, nullable=False),
    Column("tags_json", Text, nullable=False),
    Column("created_at", Text, nullable=False),
)

engine_evaluations = Table(
    "engine_evaluations",
    metadata,
    Column("id", Text, primary_key=True),
    Column("fen", Text, nullable=False),
    Column("engine", Text, nullable=False),
    Column("depth", Integer),
    Column("nodes", Integer),
    Column("time_ms", Integer),
    Column("score_cp", Integer),
    Column("mate_in", Integer),
    Column("best_move_uci", Text),
    Column("pv_json", Text, nullable=False),
    Column("wdl_json", Text),
    Column("created_at", Text, nullable=False),
    UniqueConstraint("fen", "engine", "depth", "nodes", "time_ms"),
)

moves = Table(
    "moves",
    metadata,
    Column("id", Text, primary_key=True),
    Column("game_id", Text, ForeignKey("games.id", ondelete="CASCADE")),
    Column("ply", Integer, nullable=False),
    Column("move_number", Integer, nullable=False),
    Column("side_to_move", Text, nullable=False),
    Column("uci", Text, nullable=False),
    Column("san", Text, nullable=False),
    Column("fen_before", Text, nullable=False),
    Column("fen_after", Text, nullable=False),
    Column("engine_eval_before_id", Text, ForeignKey("engine_evaluations.id")),
    Column("engine_eval_after_id", Text, ForeignKey("engine_evaluations.id")),
    Column("best_move_uci", Text),
    Column("best_move_eval_id", Text, ForeignKey("engine_evaluations.id")),
    Column("classification", Text, nullable=False),
    Column("comment", Text),
    Column("tags_json", Text, nullable=False),
    Column("source", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Index("idx_moves_game_ply", "game_id", "ply"),
    Index("idx_moves_fen_before", "fen_before"),
    Index("idx_moves_uci", "uci"),
)

analysis_results = Table(
    "analysis_results",
    metadata,
    Column("id", Text, primary_key=True),
    Column("game_id", Text, ForeignKey("games.id", ondelete="CASCADE"), nullable=False),
    Column("analyzed_at", Text, nullable=False),
    Column("engine", Text, nullable=False),
    Column("depth", Integer),
    Column("summary_json", Text, nullable=False),
    Column("critical_ply_json", Text, nullable=False),
    Column("config_json", Text, nullable=False),
)

maia_predictions = Table(
    "maia_predictions",
    metadata,
    Column("id", Text, primary_key=True),
    Column("fen", Text, nullable=False),
    Column("move_uci", Text, nullable=False),
    Column("probability", Float, nullable=False),
    Column("model", Text, nullable=False),
    Column("rating_bucket", Text),
    Column("rank", Integer),
    Column("sample_size", Integer),
    Column("created_at", Text, nullable=False),
    UniqueConstraint("fen", "move_uci", "model", "rating_bucket"),
    Index("idx_maia_predictions_fen", "fen"),
)

repertoires = Table(
    "repertoires",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_profile_id", Text, ForeignKey("user_profiles.id")),
    Column("name", Text, nullable=False),
    Column("color", Text, nullable=False),
    Column("root_fen", Text, nullable=False),
    Column("root_node_id", Text),
    Column("main_engine", Text, nullable=False),
    Column("human_model", Text, nullable=False),
    Column("branch_depth", Integer, nullable=False),
    Column("opponent_branch_threshold", Float, nullable=False),
    Column("sub_branch_threshold", Float, nullable=False),
    Column("max_total_nodes", Integer, nullable=False),
    Column("max_line_length", Integer, nullable=False),
    Column("notes", Text),
    Column("tags_json", Text, nullable=False),
    Column("is_active", Integer, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    # Phase 5 (teams/sharing): nullable so the existing repository insert is
    # untouched — NULL visibility is treated as "private". A repertoire shared to a
    # team carries team_id + visibility='team'. No DB-level FK to the ORM ``teams``
    # table on purpose: it would couple every legacy ``create_all`` to importing
    # api.models, and a dangling team_id fails closed (the read gate checks live
    # membership), so referential integrity is enforced in app logic instead.
    Column("team_id", Text),
    Column("visibility", Text),
    Index("idx_repertoires_owner", "user_profile_id"),
    Index("idx_repertoires_team", "team_id"),
)

opening_nodes = Table(
    "opening_nodes",
    metadata,
    Column("id", Text, primary_key=True),
    Column(
        "repertoire_id",
        Text,
        ForeignKey("repertoires.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("parent_id", Text, ForeignKey("opening_nodes.id", ondelete="CASCADE")),
    Column("move_id", Text, ForeignKey("moves.id")),
    Column("fen", Text, nullable=False),
    Column("side_to_move", Text, nullable=False),
    Column("engine_evaluation_id", Text, ForeignKey("engine_evaluations.id")),
    Column("maia_probability", Float),
    Column("is_mainline", Integer, nullable=False),
    Column("is_user_prepared_move", Integer, nullable=False),
    Column("is_enabled", Integer, nullable=False),
    Column("priority", Float, nullable=False),
    Column("comment", Text),
    Column("tags_json", Text, nullable=False),
    Column("arrows_json", Text, nullable=False),
    Column("circles_json", Text, nullable=False),
    Column("tactical_warning", Text),
    Column("strategic_idea", Text),
    Column("typical_plan", Text),
    Column("source", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    Index("idx_opening_nodes_repertoire_parent", "repertoire_id", "parent_id"),
    Index("idx_opening_nodes_fen", "fen"),
)

opening_lines = Table(
    "opening_lines",
    metadata,
    Column("id", Text, primary_key=True),
    Column(
        "repertoire_id",
        Text,
        ForeignKey("repertoires.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("name", Text),
    Column("node_ids_json", Text, nullable=False),
    Column("priority", Float, nullable=False),
    Column("tags_json", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)

generation_runs = Table(
    "generation_runs",
    metadata,
    Column("id", Text, primary_key=True),
    Column(
        "repertoire_id",
        Text,
        ForeignKey("repertoires.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("root_node_id", Text, ForeignKey("opening_nodes.id"), nullable=False),
    Column("config_json", Text, nullable=False),
    Column("summary_json", Text, nullable=False),
    Column("undo_log_json", Text, nullable=False),
    Column("created_at", Text, nullable=False),
)

training_sessions = Table(
    "training_sessions",
    metadata,
    Column("id", Text, primary_key=True),
    Column(
        "repertoire_id",
        Text,
        ForeignKey("repertoires.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("mode", Text, nullable=False),
    Column("line_order_json", Text, nullable=False),
    Column("current_index", Integer, nullable=False),
    Column("current_node_id", Text, ForeignKey("opening_nodes.id")),
    Column("mistakes_json", Text, nullable=False),
    Column("mastered_nodes_json", Text, nullable=False),
    Column("seed", Integer),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)

training_progress = Table(
    "training_progress",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_profile_id", Text, ForeignKey("user_profiles.id")),
    Column(
        "repertoire_id",
        Text,
        ForeignKey("repertoires.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column(
        "node_id",
        Text,
        ForeignKey("opening_nodes.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("attempts", Integer, nullable=False),
    Column("correct_attempts", Integer, nullable=False),
    Column("last_reviewed_at", Text),
    Column("spaced_repetition_score", Float, nullable=False),
    Column("due_at", Text),
    Column("is_mastered", Integer, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    UniqueConstraint("user_profile_id", "repertoire_id", "node_id"),
)

training_mistakes = Table(
    "training_mistakes",
    metadata,
    Column("id", Text, primary_key=True),
    Column("session_id", Text, ForeignKey("training_sessions.id", ondelete="SET NULL")),
    Column(
        "repertoire_id",
        Text,
        ForeignKey("repertoires.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column(
        "node_id",
        Text,
        ForeignKey("opening_nodes.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("expected_uci", Text, nullable=False),
    Column("played_uci", Text, nullable=False),
    Column("fen_before", Text, nullable=False),
    Column("mistake_count", Integer, nullable=False),
    Column("resolved_at", Text),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)

lichess_imports = Table(
    "lichess_imports",
    metadata,
    Column("id", Text, primary_key=True),
    Column("username", Text, nullable=False),
    Column("requested_count", Integer, nullable=False),
    Column("imported_game_ids_json", Text, nullable=False),
    Column("skipped_game_ids_json", Text, nullable=False),
    Column("errors_json", Text, nullable=False),
    Column("created_at", Text, nullable=False),
)

practical_opening_matches = Table(
    "practical_opening_matches",
    metadata,
    Column("id", Text, primary_key=True),
    Column("game_id", Text, ForeignKey("games.id", ondelete="CASCADE"), nullable=False),
    Column("user_color", Text, nullable=False),
    Column("repertoire_id", Text, ForeignKey("repertoires.id", ondelete="SET NULL")),
    Column("matched_plies", Integer, nullable=False),
    Column("last_matched_node_id", Text, ForeignKey("opening_nodes.id")),
    Column("departure_ply", Integer),
    Column("departure_move_uci", Text),
    Column("departure_reason", Text, nullable=False),
    Column("created_at", Text, nullable=False),
)

engine_settings = Table(
    "engine_settings",
    metadata,
    Column("id", Text, primary_key=True),
    Column("engine_name", Text, nullable=False),
    Column("executable_path", Text),
    Column("default_depth", Integer),
    Column("default_nodes", Integer),
    Column("default_time_ms", Integer),
    Column("options_json", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)

app_settings = Table(
    "app_settings",
    metadata,
    Column("key", Text, primary_key=True),
    Column("value_json", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)

# Created by the multi-tenancy migration, not schema.sql: maps a browser cookie
# (token hash) to a user_profiles row. Legacy guest/Lichess sessions live here.
user_sessions = Table(
    "user_sessions",
    metadata,
    Column("token_hash", Text, primary_key=True),
    Column(
        "user_profile_id",
        Text,
        ForeignKey("user_profiles.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("created_at", Text, nullable=False),
    Column("last_seen_at", Text, nullable=False),
    Index("idx_user_sessions_profile", "user_profile_id"),
)

# Every legacy ``Table`` object, for ``metadata.create_all(tables=...)``. The shared
# ``Base.metadata`` also carries the new SaaS identity tables (``api/models.py``), so
# the DDL helpers in ``database.py`` pass this list explicitly to create *only* the
# legacy domain schema rather than the whole metadata. ``create_all`` resolves FK
# ordering itself, so the order here is irrelevant.
LEGACY_TABLES = (
    user_profiles,
    games,
    positions,
    engine_evaluations,
    moves,
    analysis_results,
    maia_predictions,
    repertoires,
    opening_nodes,
    opening_lines,
    generation_runs,
    training_sessions,
    training_progress,
    training_mistakes,
    lichess_imports,
    practical_opening_matches,
    engine_settings,
    app_settings,
    user_sessions,
)
