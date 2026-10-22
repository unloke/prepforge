"""Training sessions belong to the user who trains, not the repertoire's owner.

Revision ID: e9c1d3f5a7b9
Revises: c5d7e9f1a3b5
Create Date: 2026-10-22 00:00:00.000000

Anyone a repertoire is shared with may train it with their own progress, so a
session names its user. Sessions are resumable scratch state: existing rows are
dropped rather than carried over (AGENTS.md: no backfill).
"""
from alembic import op
import sqlalchemy as sa


revision = "e9c1d3f5a7b9"
down_revision = "c5d7e9f1a3b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DELETE FROM train_attempt_receipts")
    op.execute("DELETE FROM training_sessions")
    with op.batch_alter_table("training_sessions") as batch:
        batch.drop_index("idx_training_sessions_rep_mode_updated")
        batch.add_column(sa.Column("owner_user_id", sa.Text(), nullable=False))
        batch.create_foreign_key(
            "fk_training_sessions_owner_user_id", "users", ["owner_user_id"], ["id"], ondelete="CASCADE"
        )
        batch.create_index(
            "idx_training_sessions_rep_owner_mode_updated",
            ["repertoire_id", "owner_user_id", "mode", "updated_at"],
        )


def downgrade() -> None:
    with op.batch_alter_table("training_sessions") as batch:
        batch.drop_index("idx_training_sessions_rep_owner_mode_updated")
        batch.drop_constraint("fk_training_sessions_owner_user_id", type_="foreignkey")
        batch.drop_column("owner_user_id")
        batch.create_index("idx_training_sessions_rep_mode_updated", ["repertoire_id", "mode", "updated_at"])
