"""A smart session names its scope: all repertoires, one, or picked targets.

Revision ID: 7b3e5a9c1d2f
Revises: 528e704717a9
Create Date: 2026-10-22 02:00:00.000000

Start resumes only a session of the requested scope, so a one-repertoire queue
is never served from "all repertoires" (both anchor on a repertoire row).
"""
from alembic import op
import sqlalchemy as sa


revision = "7b3e5a9c1d2f"
down_revision = "528e704717a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("training_sessions") as batch:
        batch.add_column(sa.Column("scope", sa.Text(), nullable=False, server_default="repertoire"))


def downgrade() -> None:
    with op.batch_alter_table("training_sessions") as batch:
        batch.drop_column("scope")
