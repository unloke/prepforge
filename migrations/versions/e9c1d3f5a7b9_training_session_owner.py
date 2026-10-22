"""Training sessions belong to the user who trains, not the repertoire's owner.

Revision ID: e9c1d3f5a7b9
Revises: c5d7e9f1a3b5
Create Date: 2026-10-22 00:00:00.000000

Anyone a repertoire is shared with may train it with their own progress, so a
session names its user. Every existing session was the repertoire owner's, so
owner_user_id is filled from the repertoire; in-progress queues and their
attempt receipts survive. A session whose repertoire has no owner has no one to
resume it and is removed with its receipts.
"""
from alembic import op
import sqlalchemy as sa


revision = "e9c1d3f5a7b9"
down_revision = "c5d7e9f1a3b5"
branch_labels = None
depends_on = None

OWNERLESS = (
    "SELECT s.id FROM training_sessions s LEFT JOIN repertoires r ON r.id = s.repertoire_id "
    "WHERE r.owner_user_id IS NULL"
)


def upgrade() -> None:
    op.add_column("training_sessions", sa.Column("owner_user_id", sa.Text(), nullable=True))
    op.execute(
        "UPDATE training_sessions SET owner_user_id = "
        "(SELECT owner_user_id FROM repertoires WHERE repertoires.id = training_sessions.repertoire_id)"
    )
    op.execute(f"DELETE FROM train_attempt_receipts WHERE session_id IN ({OWNERLESS})")
    op.execute("DELETE FROM training_sessions WHERE owner_user_id IS NULL")
    with op.batch_alter_table("training_sessions") as batch:
        batch.drop_index("idx_training_sessions_rep_mode_updated")
        batch.alter_column("owner_user_id", existing_type=sa.Text(), nullable=False)
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
