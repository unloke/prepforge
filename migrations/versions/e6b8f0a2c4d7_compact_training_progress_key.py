"""training_progress: key on what progress is progress on.

Revision ID: e6b8f0a2c4d7
Revises: d5a7e9f1b3c6
Create Date: 2026-10-20 00:00:00.000000

The table carried a 50-character ``id`` that was a hash of
(owner, repertoire, node), a ``UNIQUE`` constraint on those same three
columns, two timestamps no read path ever touched, and three indexes over
the key columns. On the measured dataset its 1334 rows took 905 KB, while the
payload they actually hold was 386 KB.

Progress is now identified by ``(node_id, owner_user_id)`` — one row per owner
per node, which is all the unique id ever encoded. The node leads so the
``node_id`` cascade lookup taken when a node is deleted (d4e6f8a0b2c3) seeks
the primary key instead of scanning; the owner keeps its own index for the
account-export stream, and ``repertoire_id`` remains because the scoping reads
filter on it. The unread timestamps and the redundant indexes go with the id.
Rows are re-keyed from their own columns, so nothing has to be regenerated.
"""
from alembic import op
import sqlalchemy as sa


revision = "e6b8f0a2c4d7"
down_revision = "d5a7e9f1b3c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TABLE training_progress DROP CONSTRAINT uq_training_progress_owner")
        op.drop_index("idx_training_progress_rep_user", table_name="training_progress")
        op.drop_index("idx_training_progress_node", table_name="training_progress")
        op.drop_constraint(
            "fk_training_progress_owner_user_id", "training_progress", type_="foreignkey"
        )
        op.execute("ALTER TABLE training_progress DROP CONSTRAINT training_progress_pkey")
        op.execute("ALTER TABLE training_progress ALTER COLUMN owner_user_id SET NOT NULL")
        op.execute("ALTER TABLE training_progress ADD PRIMARY KEY (node_id, owner_user_id)")
        op.create_foreign_key(
            "fk_training_progress_owner_user_id", "training_progress", "users",
            ["owner_user_id"], ["id"], ondelete="CASCADE",
        )
        op.drop_column("training_progress", "id")
        op.drop_column("training_progress", "created_at")
        op.drop_column("training_progress", "updated_at")
        op.create_index("idx_training_progress_owner", "training_progress", ["owner_user_id"])
        return

    # SQLite cannot alter a primary key or drop a constraint in place: rebuild
    # the table and re-key every row from its own columns.
    op.execute(
        "CREATE TABLE training_progress_compact ("
        " owner_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,"
        " repertoire_id TEXT NOT NULL REFERENCES repertoires (id) ON DELETE CASCADE,"
        " node_id TEXT NOT NULL REFERENCES opening_nodes (id) ON DELETE CASCADE,"
        " attempts INTEGER NOT NULL, correct_attempts INTEGER NOT NULL,"
        " last_reviewed_at DATETIME, spaced_repetition_score FLOAT NOT NULL,"
        " due_at DATETIME, is_mastered INTEGER NOT NULL,"
        " PRIMARY KEY (node_id, owner_user_id))"
    )
    op.execute(
        "INSERT INTO training_progress_compact"
        " (owner_user_id, repertoire_id, node_id, attempts, correct_attempts,"
        "  last_reviewed_at, spaced_repetition_score, due_at, is_mastered)"
        " SELECT owner_user_id, repertoire_id, node_id, attempts, correct_attempts,"
        "  last_reviewed_at, spaced_repetition_score, due_at, is_mastered"
        " FROM training_progress"
    )
    op.execute("DROP TABLE training_progress")
    op.execute("ALTER TABLE training_progress_compact RENAME TO training_progress")
    op.create_index("idx_training_progress_due", "training_progress", ["due_at"])
    op.create_index("idx_training_progress_owner", "training_progress", ["owner_user_id"])


def downgrade() -> None:
    raise NotImplementedError("the compact progress key is a forward-only schema change")
