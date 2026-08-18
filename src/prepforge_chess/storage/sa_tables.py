"""Domain schema as SQLAlchemy Core tables.

Compact persistent representation (no legacy dual-format):
* games store ``initial_fen`` + ``uci_blob``; PGN/SAN/FEN sequences are derived;
* moves hold only per-ply annotations that cannot be rebuilt from the UCI blob;
* positions is a full-FEN catalog (6 fields, unique); never a short hash;
* engine_evaluations key by (position_id, engine, depth, nodes, time_ms)
  with unset limits stored as ``codec.UNSET_SEARCH_LIMIT`` so UNIQUE is NULL-safe;
* opening nodes store arriving UCI and reconstruct FEN by walking the tree.
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
    Column("uci_blob", Text, nullable=False),
    Column("white", Text),
    Column("black", Text),
    Column("result", Text, nullable=False),
    Column("event", Text),
    Column("site", Text),
    Column("played_at", Text),
    Column("lichess_id", Text),
    Column("tags_json", Text, nullable=False),
    Column("owner_user_id", Text),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    Index("idx_games_owner", "owner_user_id"),
    Index("idx_games_owner_lichess", "owner_user_id", "lichess_id", unique=True),
)

positions = Table(
    "positions",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("fen", Text, nullable=False, unique=True),
)

engine_evaluations = Table(
    "engine_evaluations",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("position_id", Integer, ForeignKey("positions.id"), nullable=False),
    Column("engine", Text, nullable=False),
    Column("depth", Integer, nullable=False),
    Column("nodes", Integer, nullable=False),
    Column("time_ms", Integer, nullable=False),
    Column("score_cp", Integer),
    Column("mate_in", Integer),
    Column("best_move_uci", Text),
    Column("pv", Text, nullable=False),
    Column("wdl_win", Integer),
    Column("wdl_draw", Integer),
    Column("wdl_loss", Integer),
    UniqueConstraint("position_id", "engine", "depth", "nodes", "time_ms"),
)

moves = Table(
    "moves",
    metadata,
    Column("game_id", Text, ForeignKey("games.id", ondelete="CASCADE"), primary_key=True),
    Column("ply", Integer, primary_key=True),
    Column("uci", Text, nullable=False),
    Column("engine_eval_before_id", Integer, ForeignKey("engine_evaluations.id")),
    Column("engine_eval_after_id", Integer, ForeignKey("engine_evaluations.id")),
    Column("best_move_uci", Text),
    Column("best_move_eval_id", Integer, ForeignKey("engine_evaluations.id")),
    Column("classification", Text, nullable=False),
    Column("comment", Text),
    Column("tags_json", Text),
    Column("source", Text, nullable=False),
    Index("idx_moves_game_ply", "game_id", "ply"),
)

analysis_results = Table(
    "analysis_results",
    metadata,
    Column("id", Text, primary_key=True),
    Column(
        "game_id",
        Text,
        ForeignKey("games.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("analyzed_at", Text, nullable=False),
    Column("engine", Text, nullable=False),
    Column("depth", Integer),
    Column("summary_json", Text, nullable=False),
    Column("critical_ply", Text, nullable=False),
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
    Column("team_id", Text),
    Column("visibility", Text),
    Column("health_json", Text),
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
    Column("uci", Text),
    Column("engine_evaluation_id", Integer, ForeignKey("engine_evaluations.id")),
    Column("maia_probability", Float),
    Column("is_mainline", Integer, nullable=False),
    Column("is_user_prepared_move", Integer, nullable=False),
    Column("is_enabled", Integer, nullable=False),
    Column("priority", Float, nullable=False),
    Column("comment", Text),
    Column("tags_json", Text),
    Column("arrows_json", Text),
    Column("circles_json", Text),
    Column("tactical_warning", Text),
    Column("strategic_idea", Text),
    Column("typical_plan", Text),
    Column("source", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    Index("idx_opening_nodes_repertoire_parent", "repertoire_id", "parent_id"),
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
    Index(
        "idx_training_sessions_rep_mode_updated",
        "repertoire_id",
        "mode",
        "updated_at",
    ),
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
    Index("idx_training_progress_rep_user", "repertoire_id", "user_profile_id"),
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

DOMAIN_TABLES = (
    user_profiles,
    games,
    positions,
    engine_evaluations,
    moves,
    analysis_results,
    repertoires,
    opening_nodes,
    training_sessions,
    training_progress,
    engine_settings,
    app_settings,
    user_sessions,
)


