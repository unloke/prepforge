"""Repertoire access roles: per-team and per-person grants, and a link role.

Revision ID: c5d7e9f1a3b5
Revises: c3e5a7b9d1f2
Create Date: 2026-10-21 00:00:00.000000

Sharing was one team per repertoire (``repertoires.team_id`` + ``visibility``),
always read-only, with copy always allowed. ``repertoire_access`` replaces both
columns: any number of teams and people, each with a role (view / copy / edit).
``share_role`` says what "anyone with the link" may do (view / copy), and a link
is now off until the owner turns it on. One forward change, no data carried over
(AGENTS.md: no users yet, no backfill).
"""
from alembic import op
import sqlalchemy as sa


revision = "c5d7e9f1a3b5"
down_revision = "c3e5a7b9d1f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("repertoires") as batch:
        batch.drop_index("idx_repertoires_team")
        batch.drop_column("team_id")
        batch.drop_column("visibility")
        batch.alter_column("share_enabled", server_default="0", existing_type=sa.Integer(), existing_nullable=False)
        batch.add_column(sa.Column("share_role", sa.String(length=8), nullable=False, server_default="view"))
    op.create_table(
        "repertoire_access",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("repertoire_id", sa.Text(), sa.ForeignKey("repertoires.id", ondelete="CASCADE"), nullable=False),
        sa.Column("team_id", sa.String(length=32), sa.ForeignKey("teams.id", ondelete="CASCADE")),
        sa.Column("user_id", sa.String(length=32), sa.ForeignKey("users.id", ondelete="CASCADE")),
        sa.Column("role", sa.String(length=8), nullable=False),
        sa.Column("created_by", sa.String(length=32), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("(team_id IS NULL) <> (user_id IS NULL)", name="ck_repertoire_access_one_target"),
        sa.CheckConstraint("role IN ('view', 'copy', 'edit')", name="ck_repertoire_access_role"),
        sa.UniqueConstraint("repertoire_id", "team_id", name="uq_repertoire_access_team"),
        sa.UniqueConstraint("repertoire_id", "user_id", name="uq_repertoire_access_user"),
    )
    op.create_index("ix_repertoire_access_team_id", "repertoire_access", ["team_id"])
    op.create_index("ix_repertoire_access_user_id", "repertoire_access", ["user_id"])


def downgrade() -> None:
    op.drop_table("repertoire_access")
    with op.batch_alter_table("repertoires") as batch:
        batch.drop_column("share_role")
        batch.alter_column("share_enabled", server_default="1", existing_type=sa.Integer(), existing_nullable=False)
        batch.add_column(sa.Column("visibility", sa.Text(), nullable=True))
        batch.add_column(sa.Column("team_id", sa.Text(), nullable=True))
        batch.create_index("idx_repertoires_team", ["team_id"], unique=False)
