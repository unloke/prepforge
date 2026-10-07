"""Index the child side of opening-node cascades.

Deleting a node (or a whole repertoire) makes the database look up rows that
reference it through ``opening_nodes.parent_id``, ``training_progress.node_id``
and ``training_sessions.current_node_id``. Without an index each lookup is a full
table scan, so a repertoire delete grew quadratically (8,000 nodes: 1.4 s → 25 ms).

Revision ID: d4e6f8a0b2c3
Revises: c2d8e4f6a901
"""
from alembic import op

revision = "d4e6f8a0b2c3"
down_revision = "c2d8e4f6a901"
branch_labels = None
depends_on = None

INDEXES = (
    ("idx_opening_nodes_parent", "opening_nodes", "parent_id"),
    ("idx_training_progress_node", "training_progress", "node_id"),
    ("idx_training_sessions_current_node", "training_sessions", "current_node_id"),
)


def upgrade() -> None:
    for name, table, column in INDEXES:
        op.create_index(name, table, [column])


def downgrade() -> None:
    for name, table, _column in INDEXES:
        op.drop_index(name, table_name=table)
