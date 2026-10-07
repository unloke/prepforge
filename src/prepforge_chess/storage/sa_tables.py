"""Domain schema as SQLAlchemy Core tables.

Compact persistent representation:
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

from datetime import datetime, timezone
import uuid
from sqlalchemy import Boolean, String, Enum as SAEnum, MetaData
from prepforge_chess.storage.types import Plan, TeamRole
from prepforge_chess.storage.datetime_type import UTCDateTime

metadata = MetaData()


def _uuid():
    return uuid.uuid4().hex


def _now():
    return datetime.now(timezone.utc)


users = Table(
    'users', metadata,
    Column('id', String(length=32), primary_key=True, default=_uuid),
    Column('email', String(length=320), nullable=False),
    Column('password_hash', String(length=255)),
    Column('plan', SAEnum(Plan, native_enum=False, length=16), nullable=False, default=Plan.free),
    Column('display_name', String(length=120)),
    Column('stripe_customer_id', String(length=64)),
    Column('created_at', UTCDateTime(), nullable=False, default=_now),
    Column('updated_at', UTCDateTime(), nullable=False, default=_now, onupdate=_now),
    Index('ix_users_email', 'email', unique=True),
    Index('ix_users_stripe_customer_id', 'stripe_customer_id'),
)

linked_accounts = Table(
    'linked_accounts', metadata,
    Column('id', String(length=32), primary_key=True, default=_uuid),
    Column('user_id', String(length=32), ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
    Column('provider', String(length=32), nullable=False),
    Column('provider_user_id', String(length=120), nullable=False),
    Column('encrypted_token', String(length=2048)),
    Column('is_primary', Boolean(), nullable=False, default=True),
    Column('created_at', UTCDateTime(), nullable=False, default=_now),
    UniqueConstraint('provider', 'provider_user_id', name='uq_provider_identity'),
    UniqueConstraint('user_id', 'provider', 'provider_user_id', name='uq_user_provider_identity'),
    Index('ix_linked_accounts_user_id', 'user_id'),
)

teams = Table(
    'teams', metadata,
    Column('id', String(length=32), primary_key=True, default=_uuid),
    Column('name', String(length=120), nullable=False),
    Column('owner_user_id', String(length=32), ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
    Column('kind', String(length=16), nullable=False, default='team'),
    Column('created_at', UTCDateTime(), nullable=False, default=_now),
    Index('ix_teams_owner_user_id', 'owner_user_id'),
)

team_members = Table(
    'team_members', metadata,
    Column('id', String(length=32), primary_key=True, default=_uuid),
    Column('team_id', String(length=32), ForeignKey('teams.id', ondelete='CASCADE'), nullable=False),
    Column('user_id', String(length=32), ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
    Column('role', SAEnum(TeamRole, native_enum=False, length=16), nullable=False, default=TeamRole.member),
    Column('created_at', UTCDateTime(), nullable=False, default=_now),
    UniqueConstraint('team_id', 'user_id', name='uq_team_member'),
    Index('ix_team_members_team_id', 'team_id'),
    Index('ix_team_members_user_id', 'user_id'),
)

team_invites = Table(
    'team_invites', metadata,
    Column('id', String(length=32), primary_key=True, default=_uuid),
    Column('team_id', String(length=32), ForeignKey('teams.id', ondelete='CASCADE'), nullable=False),
    Column('code_hash', String(length=64), nullable=False),
    Column('created_by_user_id', String(length=32), ForeignKey('users.id', ondelete='SET NULL')),
    Column('expires_at', UTCDateTime()),
    Column('created_at', UTCDateTime(), nullable=False, default=_now),
    Index('ix_team_invites_code_hash', 'code_hash', unique=True),
    Index('ix_team_invites_team_id', 'team_id', unique=True),
)

user_settings = Table(
    'user_settings', metadata,
    Column('user_id', String(length=32), primary_key=True),
    Column('key', String(length=120), primary_key=True),
    Column('value_json', Text(), nullable=False, default='null'),
    Column('updated_at', UTCDateTime(), nullable=False, default=_now),
    Index('ix_user_settings_user_id', 'user_id'),
)

train_attempt_receipts = Table(
    'train_attempt_receipts', metadata,
    Column('session_id', String(length=64), primary_key=True),
    Column('attempt_uuid', String(length=64), primary_key=True),
    Column('node_id', String(length=64), nullable=False),
    Column('correct', Boolean(), nullable=False),
    Column('created_at', UTCDateTime(), nullable=False, default=_now),
    Index('ix_train_attempt_receipts_created_at', 'created_at'),
    Index('ix_train_attempt_receipts_session_id', 'session_id'),
)

password_reset_tokens = Table(
    'password_reset_tokens', metadata,
    Column('id', String(length=32), primary_key=True, default=_uuid),
    Column('user_id', String(length=32), ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
    Column('token_hash', String(length=64), nullable=False),
    Column('created_at', UTCDateTime(), nullable=False, default=_now),
    Column('expires_at', UTCDateTime(), nullable=False),
    Column('used_at', UTCDateTime()),
    Index('ix_password_reset_tokens_token_hash', 'token_hash', unique=True),
    Index('ix_password_reset_tokens_user_id', 'user_id'),
)

stripe_events = Table(
    'stripe_events', metadata,
    Column('id', String(length=64), primary_key=True),
    Column('type', String(length=120), nullable=False),
    Column('processed_at', UTCDateTime(), nullable=False, default=_now),
)

auth_sessions = Table(
    'auth_sessions', metadata,
    Column('token_hash', String(length=64), primary_key=True),
    Column('user_id', String(length=32), ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
    Column('created_at', UTCDateTime(), nullable=False, default=_now),
    Column('last_seen_at', UTCDateTime(), nullable=False, default=_now),
    Index('ix_auth_sessions_user_id', 'user_id'),
)

games = Table(
    "games",
    metadata,
    Column("id", Text, primary_key=True),
    Column("source", Text, nullable=False),
    Column("initial_fen", Text, nullable=False),
    Column("uci_blob", Text, nullable=False),
    Column("pgn", Text),
    Column("white", Text),
    Column("black", Text),
    Column("result", Text, nullable=False),
    Column("event", Text),
    Column("site", Text),
    Column("played_at", UTCDateTime()),
    Column("lichess_id", Text),
    Column("tags_json", Text, nullable=False),
    Column("owner_user_id", Text),
    Column("created_at", UTCDateTime(), nullable=False),
    Column("updated_at", UTCDateTime(), nullable=False),
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
    Column("analyzed_at", UTCDateTime(), nullable=False),
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
    Column("notes", Text),
    Column("tags_json", Text, nullable=False),
    Column("is_active", Integer, nullable=False),
    Column("created_at", UTCDateTime(), nullable=False),
    Column("updated_at", UTCDateTime(), nullable=False),
    Column("team_id", Text),
    Column("visibility", Text),
    Column("health_json", Text),
    # Mutation revision (D-02): bumped on every tree/metadata write; Build
    # mutations may send ``base_revision`` and get 409 when it is stale.
    Column("revision", Integer, nullable=False, server_default="0"),
    # Public share-link governance (F-01). ``share_rev`` is mixed into the
    # token signature: rotating bumps it and kills every previously minted
    # link; ``share_enabled`` is the independent on/off switch.
    Column("share_rev", Integer, nullable=False, server_default="0"),
    Column("share_enabled", Integer, nullable=False, server_default="1"),
    Column("share_expires_at", UTCDateTime()),
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
    Column("created_at", UTCDateTime(), nullable=False),
    Column("updated_at", UTCDateTime(), nullable=False),
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
    Column("created_at", UTCDateTime(), nullable=False),
    Column("updated_at", UTCDateTime(), nullable=False),
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
    Column("last_reviewed_at", UTCDateTime()),
    Column("spaced_repetition_score", Float, nullable=False),
    Column("due_at", UTCDateTime()),
    Column("is_mastered", Integer, nullable=False),
    Column("created_at", UTCDateTime(), nullable=False),
    Column("updated_at", UTCDateTime(), nullable=False),
    UniqueConstraint("owner_user_id", "repertoire_id", "node_id", name="uq_training_progress_owner"),
    Index("idx_training_progress_rep_user", "repertoire_id", "owner_user_id"),
    # Dashboard due-review range scan and scheduler sort.
    Index("idx_training_progress_due", "due_at"),
)
