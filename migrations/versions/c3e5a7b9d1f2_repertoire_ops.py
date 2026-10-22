"""repertoire_ops: the per-revision write log devices sync from.

Revision ID: c3e5a7b9d1f2
Revises: b9e1f3a5c7d0
Create Date: 2026-10-21 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c3e5a7b9d1f2"
down_revision: Union[str, Sequence[str], None] = "b9e1f3a5c7d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "repertoire_ops",
        sa.Column("repertoire_id", sa.Text(), sa.ForeignKey("repertoires.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("revision", sa.Integer(), primary_key=True),
        sa.Column("actor_user_id", sa.Text(), sa.ForeignKey(
            "users.id", ondelete="SET NULL", name="fk_repertoire_ops_actor_user_id")),
        sa.Column("client_id", sa.Text()),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("op_json", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("repertoire_ops")
