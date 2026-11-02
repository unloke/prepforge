"""Position-anchored repertoire discussions."""
from alembic import op
import sqlalchemy as sa
from prepforge_chess.storage.datetime_type import UTCDateTime

revision = "8e4a6c2d0f91"
down_revision = "7b3e5a9c1d2f"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "position_threads",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("repertoire_id", sa.Text(), sa.ForeignKey("repertoires.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position_key", sa.Text(), nullable=False),
        sa.Column("fen", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Text(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("resolved", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.UniqueConstraint("repertoire_id", "position_key", name="uq_position_threads_position"),
    )
    op.create_table(
        "position_messages",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("thread_id", sa.Text(), sa.ForeignKey("position_threads.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_id", sa.Text(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
    )
    op.create_index("ix_position_messages_thread_id", "position_messages", ["thread_id"])


def downgrade():
    op.drop_table("position_messages")
    op.drop_table("position_threads")
