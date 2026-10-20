"""Compact domain storage: keys, digests and columns that stored the same thing twice.

Revision ID: b9e1f3a5c7d0
Revises: e7a1c3d5f9b2
Create Date: 2026-10-20 00:00:00.000000

One forward change for the whole domain schema. There is no data-preserving
upgrade: PrepForge has no users yet, so there is no old data to convert and no
reason to carry a conversion path (AGENTS.md: schema changes are one forward
migration with no backfill scaffolding).

What changes, and why each column was storing something twice:

* ``moves.generated_meta_json`` is gone. It repeated the same run-level
  provenance (versions, engine, depth, analyzed_at) on every analysed ply and
  nothing read it; the run's provenance is recorded once in
  ``analysis_results.quality_json``.
* ``engine_evaluations.fingerprint`` is a 32-byte BLOB and the only unique key
  column. It already commits to position, engine and every search limit, so
  the old five-column key stored the same identity a second time, and the
  hex spelling doubled the digest's own cost (254 -> 150 bytes a row).
* ``training_progress`` is keyed by ``(node_id, owner_user_id)``: the
  surrogate id was a hash of that pair, the UNIQUE constraint over the same
  columns was the id in another spelling, two timestamps were never read, and
  two of the three indexes duplicated key columns. The node leads so the
  cascade lookup taken when a node is deleted (d4e6f8a0b2c3) seeks the primary
  key; the owner keeps an index for the account export.
* ``opening_nodes`` drops ``created_at``/``updated_at`` (written on every save,
  excluded by every tree read) and the bare ``parent_id`` index (the recursive
  walk seeks ``(repertoire_id, parent_id)``; the cascade lookup is by id).
* ``moves.uci`` is gone: the arriving move is ``games.uci_blob[ply - 1]`` and
  every read rebuilds the sequence from that blob.

The analysis-snapshot payload moved to ``analysis-zlib-base64-v2``, but that
is a data format, not a schema: no column, key or index changed there, and
there is nothing to convert, so this migration does not touch that table.

Every change below is an ALTER; on SQLite only ``training_progress`` needs a
table rebuild (a primary key cannot be swapped in place).
"""
from alembic import op
import sqlalchemy as sa


revision = "b9e1f3a5c7d0"
down_revision = "e7a1c3d5f9b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    sqlite = bind.dialect.name != "postgresql"

    # --- moves: no per-ply provenance blob, no copy of the arriving UCI ------
    op.drop_column("moves", "generated_meta_json")
    op.drop_column("moves", "uci")

    # --- engine_evaluations: the digest is the whole key, as raw bytes -------
    if sqlite:
        with op.batch_alter_table("engine_evaluations") as batch:
            batch.drop_constraint("uq_engine_evaluations_identity", type_="unique")
            batch.alter_column("fingerprint", type_=sa.LargeBinary(), existing_type=sa.Text())
            batch.create_unique_constraint(
                "uq_engine_evaluations_fingerprint", ["fingerprint"]
            )
    else:
        op.drop_constraint("uq_engine_evaluations_identity", "engine_evaluations", type_="unique")
        op.alter_column(
            "engine_evaluations", "fingerprint", type_=sa.LargeBinary(),
            postgresql_using="fingerprint::bytea",
        )
        op.create_unique_constraint(
            "uq_engine_evaluations_fingerprint", "engine_evaluations", ["fingerprint"]
        )

    # --- training_progress: key on what the progress is progress on ---------
    if sqlite:
        # A primary key cannot be swapped in place, so the table is rebuilt with
        # the final shape and its rows carried over by their own columns.
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
    else:
        op.drop_constraint("uq_training_progress_owner", "training_progress", type_="unique")
        op.drop_index("idx_training_progress_rep_user", table_name="training_progress")
        op.drop_index("idx_training_progress_node", table_name="training_progress")
        op.drop_constraint(
            "fk_training_progress_owner_user_id", "training_progress", type_="foreignkey"
        )
        op.drop_constraint("training_progress_pkey", "training_progress", type_="primary")
        op.create_primary_key(
            "training_progress_pkey", "training_progress", ["node_id", "owner_user_id"]
        )
        op.create_foreign_key(
            "fk_training_progress_owner_user_id", "training_progress", "users",
            ["owner_user_id"], ["id"], ondelete="CASCADE",
        )
        op.drop_column("training_progress", "id")
        op.drop_column("training_progress", "created_at")
        op.drop_column("training_progress", "updated_at")
        op.create_index("idx_training_progress_owner", "training_progress", ["owner_user_id"])

    # --- opening_nodes: no unread timestamps, no duplicate parent index -----
    op.drop_index("idx_opening_nodes_parent", table_name="opening_nodes")
    op.drop_column("opening_nodes", "created_at")
    op.drop_column("opening_nodes", "updated_at")


def downgrade() -> None:
    raise NotImplementedError(
        "compact domain storage is a forward-only schema change: there is no "
        "previous data shape to restore"
    )
