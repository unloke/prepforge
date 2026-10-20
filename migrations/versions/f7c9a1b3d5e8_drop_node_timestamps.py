"""opening_nodes: drop the two timestamps nothing reads and a duplicate index.

Revision ID: f7c9a1b3d5e8
Revises: e6b8f0a2c4d7
Create Date: 2026-10-20 00:00:00.000000

Every node save wrote ``created_at`` and ``updated_at`` (32 bytes each with
Postgres storage), while every tree read excluded them before decoding — tree
hydration has never used a node timestamp. On the measured dataset they were
94 KB of the table's 561 KB.

``idx_opening_nodes_parent`` was added by d4e6f8a0b2c3 so deleting a node could
find its children. The recursive walk already seeks
``idx_opening_nodes_repertoire_parent (repertoire_id, parent_id)``; the cascade
lookup by referrer is on ``id`` and uses the primary key. The bare
``(parent_id)`` index was thus never the chosen plan for either, and it cost
65 KB on the measured dataset.
"""
from alembic import op
import sqlalchemy as sa


revision = "f7c9a1b3d5e8"
down_revision = "e6b8f0a2c4d7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("idx_opening_nodes_parent", table_name="opening_nodes")
    op.drop_column("opening_nodes", "created_at")
    op.drop_column("opening_nodes", "updated_at")


def downgrade() -> None:
    op.add_column("opening_nodes", sa.Column("created_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("opening_nodes", sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("idx_opening_nodes_parent", "opening_nodes", ["parent_id"])
