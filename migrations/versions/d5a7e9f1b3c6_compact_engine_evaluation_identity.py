"""engine_evaluations: the content digest is the whole dedupe key, stored as bytes.

Revision ID: d5a7e9f1b3c6
Revises: c4f6d8e0a2b5
Create Date: 2026-10-20 00:00:00.000000

``fingerprint`` is a SHA-256 of the snapshot identity AND result (see
:func:`prepforge_chess.storage.codec.evaluation_fingerprint`), so it already
commits to position, engine and every search limit. Repeating those five
columns inside ``uq_engine_evaluations_identity`` therefore stored the same
identity twice, and the 64-character hex spelling doubled the digest's own
cost. On the measured dataset the table held 5063 rows in 1290 KB, of which
the digest column and its index were 708 KB.

The digest is now a 32-byte BLOB and the only unique key column. Hex to raw
bytes is a bijection of the same digest, so what dedupes does not change and
the existing rows convert in place.
"""
from alembic import op
import sqlalchemy as sa


revision = "d5a7e9f1b3c6"
down_revision = "c4f6d8e0a2b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.drop_constraint("uq_engine_evaluations_identity", "engine_evaluations", type_="unique")
        op.execute(
            "ALTER TABLE engine_evaluations ALTER COLUMN fingerprint TYPE bytea"
            " USING decode(fingerprint, 'hex')"
        )
        op.create_unique_constraint(
            "uq_engine_evaluations_fingerprint", "engine_evaluations", ["fingerprint"]
        )
        return

    # SQLite has no ALTER for constraints or column type affinity, so the table
    # is rebuilt with the new shape and its rows re-encoded.
    op.execute(
        "CREATE TABLE engine_evaluations_compact ("
        " id INTEGER NOT NULL PRIMARY KEY,"
        " position_id INTEGER NOT NULL REFERENCES positions (id),"
        " engine TEXT NOT NULL, depth INTEGER NOT NULL, nodes INTEGER NOT NULL,"
        " time_ms INTEGER NOT NULL, score_cp INTEGER, mate_in INTEGER,"
        " best_move_uci TEXT, pv TEXT NOT NULL,"
        " wdl_win INTEGER, wdl_draw INTEGER, wdl_loss INTEGER,"
        " fingerprint BLOB NOT NULL)"
    )
    op.execute(
        "INSERT INTO engine_evaluations_compact"
        " SELECT id, position_id, engine, depth, nodes, time_ms, score_cp, mate_in,"
        " best_move_uci, pv, wdl_win, wdl_draw, wdl_loss, unhex(fingerprint)"
        " FROM engine_evaluations"
    )
    op.execute("DROP TABLE engine_evaluations")
    op.execute("ALTER TABLE engine_evaluations_compact RENAME TO engine_evaluations")
    op.create_index(
        "uq_engine_evaluations_fingerprint", "engine_evaluations", ["fingerprint"], unique=True
    )


def downgrade() -> None:
    raise NotImplementedError("the compact evaluation identity is a forward-only schema change")
