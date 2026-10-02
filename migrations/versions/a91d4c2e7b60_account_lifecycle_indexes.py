"""Indexes for account keysets, latest analysis windows and receipt inventory.

Revision ID: a91d4c2e7b60
Revises: e5a7c9d21b3f
"""
from alembic import op
import sqlalchemy as sa

revision = "a91d4c2e7b60"
down_revision = "e5a7c9d21b3f"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("idx_games_owner_created", "games", ["owner_user_id", "created_at", "id"])
    op.create_index("idx_analysis_results_game_latest", "analysis_results",
                    ["game_id", sa.text("analyzed_at DESC"), sa.text("id DESC")])
    op.create_index("ix_train_attempt_receipts_created_at", "train_attempt_receipts", ["created_at"])


def downgrade():
    op.drop_index("ix_train_attempt_receipts_created_at", table_name="train_attempt_receipts")
    op.drop_index("idx_analysis_results_game_latest", table_name="analysis_results")
    op.drop_index("idx_games_owner_created", table_name="games")
