"""Domain schema as SQLAlchemy Core tables.

Compact persistent representation (no legacy dual-format):
* games store ``initial_fen`` + ``uci_blob``; PGN/SAN/FEN sequences are derived;
* moves hold only per-ply annotations that cannot be rebuilt from the UCI blob;
* positions is a full-FEN catalog (6 fields, unique); never a short hash;
* engine_evaluations key by (position_id, engine, depth, nodes, time_ms,
  fingerprint) with unset limits stored as ``codec.UNSET_SEARCH_LIMIT`` so
  UNIQUE is NULL-safe; rows are immutable evaluation snapshots, because the
  fingerprint commits to identity AND result, so a different result is always
  a different row and no snapshot is ever overwritten in place;
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

# Canonical per-user settings + train receipts are ORM-defined in api.models
# (single definition of truth on this same metadata); alias them here so
# repository code keeps one import surface.
from prepforge_chess.api import models as _orm_models  # noqa: F401

metadata = Base.metadata

user_settings = metadata.tables["user_settings"]
train_attempt_receipts = metadata.tables["train_attempt_receipts"]

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
    Index("idx_games_owner_created", "owner_user_id", "created_at", "id"),
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
    # Snapshot digest of identity + result (codec.evaluation_fingerprint).
    Column("fingerprint", Text, nullable=False),
    UniqueConstraint(
        "position_id",
        "engine",
        "depth",
        "nodes",
        "time_ms",
        "fingerprint",
        name="uq_engine_evaluations_identity",
    ),
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
    # Original / user-authored note only; the classifier writes its explanation
    # to generated_comment and rewrites it on every run (A-04).
    Column("comment", Text),
    Column("generated_comment", Text),
    # {algorithm_version, engine, depth, analysis} for the generated block.
    Column("generated_meta_json", Text),
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
    # Search/model quality metadata for this run (A-05): target vs actual
    # depth, shallow spots, Maia status, algorithm versions.
    Column("quality_json", Text),
    Column("move_results_json", Text),
)
Index("idx_analysis_results_game_latest", analysis_results.c.game_id,
      analysis_results.c.analyzed_at.desc(), analysis_results.c.id.desc())

repertoires = Table(
    "repertoires",
    metadata,
    Column("id", Text, primary_key=True),
    Column("owner_user_id", Text),
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
    # Mutation revision (D-02): bumped on every tree/metadata write; Build
    # mutations may send ``base_revision`` and get 409 when it is stale.
    Column("revision", Integer, nullable=False, server_default="0"),
    # Public share-link governance (F-01). ``share_rev`` is mixed into the
    # token signature: rotating bumps it and kills every previously minted
    # link; ``share_enabled`` is the independent on/off switch (legacy links
    # ship rev=0 / enabled=1 so pre-existing links keep working until revoked).
    Column("share_rev", Integer, nullable=False, server_default="0"),
    Column("share_enabled", Integer, nullable=False, server_default="1"),
    Column("share_expires_at", Text),
    Index("idx_repertoires_owner", "owner_user_id"),
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
    Column("state_version", Integer, nullable=False, server_default="0"),
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
    Column("owner_user_id", Text),
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
    UniqueConstraint("owner_user_id", "repertoire_id", "node_id", name="uq_training_progress_owner"),
    Index("idx_training_progress_rep_user", "repertoire_id", "owner_user_id"),
    # Dashboard due-review filter + scheduler sort: ``due_at`` is ISO-8601 UTC
    # text, so lexical range scans are correct and this index gives them a home.
    Index("idx_training_progress_due", "due_at"),
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

DOMAIN_TABLES = (
    user_settings,
    train_attempt_receipts,
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
)


