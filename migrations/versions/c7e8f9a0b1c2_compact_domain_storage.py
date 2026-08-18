"""compact domain storage rebase

Revision ID: c7e8f9a0b1c2
Revises: a1b2c3d4e5f6
Create Date: 2026-08-18

Drop obsolete unused tables and rebuild game/move/eval/opening storage
in the compact representation. No data-preserving upgrade: empty rebuild.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c7e8f9a0b1c2"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Unused writers-never-existed tables, then rebuilt domain tables.
    # Postgres needs CASCADE for leftover FKs; SQLite rejects the keyword.
    # No data-preserving upgrade: this is an empty rebuild of current schema.
    cascade = " CASCADE" if op.get_bind().dialect.name == "postgresql" else ""
    for name in (
        "training_mistakes",
        "practical_opening_matches",
        "generation_runs",
        "opening_lines",
        "lichess_imports",
        "maia_predictions",
        "training_progress",
        "training_sessions",
        "opening_nodes",
        "moves",
        "analysis_results",
        "engine_evaluations",
        "positions",
    ):
        op.execute("DROP TABLE IF EXISTS {0}{1}".format(name, cascade))

    op.create_table(
        "positions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("fen", sa.Text(), nullable=False, unique=True),
    )
    op.create_table(
        "engine_evaluations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("position_id", sa.Integer(), sa.ForeignKey("positions.id"), nullable=False),
        sa.Column("engine", sa.Text(), nullable=False),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("nodes", sa.Integer(), nullable=False),
        sa.Column("time_ms", sa.Integer(), nullable=False),
        sa.Column("score_cp", sa.Integer()),
        sa.Column("mate_in", sa.Integer()),
        sa.Column("best_move_uci", sa.Text()),
        sa.Column("pv", sa.Text(), nullable=False),
        sa.Column("wdl_win", sa.Integer()),
        sa.Column("wdl_draw", sa.Integer()),
        sa.Column("wdl_loss", sa.Integer()),
        sa.UniqueConstraint("position_id", "engine", "depth", "nodes", "time_ms"),
    )

    with op.batch_alter_table("games") as batch:
        batch.add_column(sa.Column("uci_blob", sa.Text(), nullable=False, server_default=""))
        batch.drop_column("pgn")

    op.create_table(
        "moves",
        sa.Column("game_id", sa.Text(), sa.ForeignKey("games.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("ply", sa.Integer(), primary_key=True),
        sa.Column("uci", sa.Text(), nullable=False),
        sa.Column("engine_eval_before_id", sa.Integer(), sa.ForeignKey("engine_evaluations.id")),
        sa.Column("engine_eval_after_id", sa.Integer(), sa.ForeignKey("engine_evaluations.id")),
        sa.Column("best_move_uci", sa.Text()),
        sa.Column("best_move_eval_id", sa.Integer(), sa.ForeignKey("engine_evaluations.id")),
        sa.Column("classification", sa.Text(), nullable=False),
        sa.Column("comment", sa.Text()),
        sa.Column("tags_json", sa.Text()),
        sa.Column("source", sa.Text(), nullable=False),
    )
    op.create_index("idx_moves_game_ply", "moves", ["game_id", "ply"])

    op.create_table(
        "analysis_results",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("game_id", sa.Text(), sa.ForeignKey("games.id", ondelete="CASCADE"), nullable=False),
        sa.Column("analyzed_at", sa.Text(), nullable=False),
        sa.Column("engine", sa.Text(), nullable=False),
        sa.Column("depth", sa.Integer()),
        sa.Column("summary_json", sa.Text(), nullable=False),
        sa.Column("critical_ply", sa.Text(), nullable=False),
    )

    op.create_table(
        "opening_nodes",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "repertoire_id",
            sa.Text(),
            sa.ForeignKey("repertoires.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("parent_id", sa.Text(), sa.ForeignKey("opening_nodes.id", ondelete="CASCADE")),
        sa.Column("uci", sa.Text()),
        sa.Column("engine_evaluation_id", sa.Integer(), sa.ForeignKey("engine_evaluations.id")),
        sa.Column("maia_probability", sa.Float()),
        sa.Column("is_mainline", sa.Integer(), nullable=False),
        sa.Column("is_user_prepared_move", sa.Integer(), nullable=False),
        sa.Column("is_enabled", sa.Integer(), nullable=False),
        sa.Column("priority", sa.Float(), nullable=False),
        sa.Column("comment", sa.Text()),
        sa.Column("tags_json", sa.Text()),
        sa.Column("arrows_json", sa.Text()),
        sa.Column("circles_json", sa.Text()),
        sa.Column("tactical_warning", sa.Text()),
        sa.Column("strategic_idea", sa.Text()),
        sa.Column("typical_plan", sa.Text()),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
    )
    op.create_index(
        "idx_opening_nodes_repertoire_parent", "opening_nodes", ["repertoire_id", "parent_id"]
    )

    op.create_table(
        "training_sessions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "repertoire_id",
            sa.Text(),
            sa.ForeignKey("repertoires.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("mode", sa.Text(), nullable=False),
        sa.Column("line_order_json", sa.Text(), nullable=False),
        sa.Column("current_index", sa.Integer(), nullable=False),
        sa.Column("current_node_id", sa.Text(), sa.ForeignKey("opening_nodes.id")),
        sa.Column("mistakes_json", sa.Text(), nullable=False),
        sa.Column("mastered_nodes_json", sa.Text(), nullable=False),
        sa.Column("seed", sa.Integer()),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
    )
    op.create_index(
        "idx_training_sessions_rep_mode_updated",
        "training_sessions",
        ["repertoire_id", "mode", "updated_at"],
    )
    op.create_table(
        "training_progress",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_profile_id", sa.Text(), sa.ForeignKey("user_profiles.id")),
        sa.Column(
            "repertoire_id",
            sa.Text(),
            sa.ForeignKey("repertoires.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "node_id",
            sa.Text(),
            sa.ForeignKey("opening_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("correct_attempts", sa.Integer(), nullable=False),
        sa.Column("last_reviewed_at", sa.Text()),
        sa.Column("spaced_repetition_score", sa.Float(), nullable=False),
        sa.Column("due_at", sa.Text()),
        sa.Column("is_mastered", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.UniqueConstraint("user_profile_id", "repertoire_id", "node_id"),
    )
    op.create_index(
        "idx_training_progress_rep_user",
        "training_progress",
        ["repertoire_id", "user_profile_id"],
    )


def downgrade() -> None:
    raise NotImplementedError("compact storage rebase is not reversible")
