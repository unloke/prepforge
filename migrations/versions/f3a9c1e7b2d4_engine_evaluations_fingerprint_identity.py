"""engine_evaluations: immutable snapshot identity (fingerprint).

Revision ID: f3a9c1e7b2d4
Revises: b7d21c93e4a8
Create Date: 2026-09-29 00:00:00.000000

``engine_evaluations`` was a mutable shared cache: the dedupe key
``(position_id, engine, depth, nodes, time_ms)`` plus upsert meant a later
submission with the same search identity but a different result silently
REPLACED the row — while ``moves.*_eval_id`` / ``opening_nodes.engine_evaluation_id``
treat those rows as immutable snapshots of a past analysis. A user's history
therefore changed under them whenever anyone re-ran a search (improvement
review D-01).

This migration adds ``fingerprint`` — a digest of the full snapshot identity
(engine/artifact + position + actual search depth/nodes/time) AND the result
(score/mate/best move/PV/WDL), computed by
:func:`prepforge_chess.storage.codec.evaluation_fingerprint` — to the unique
key. Identical content still dedupes onto one row (cache), while any different
result becomes its own immutable row; nothing is ever overwritten.

Existing rows are backfilled from their stored columns (the same function
serialises exactly the stored forms, so the digest is bit-for-bit
reproducible); the old rows therefore join the new identity unchanged.

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from prepforge_chess.storage import codec


# revision identifiers, used by Alembic.
revision: str = 'f3a9c1e7b2d4'
down_revision: Union[str, Sequence[str], None] = 'b7d21c93e4a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_OLD_KEY = ["position_id", "engine", "depth", "nodes", "time_ms"]
_NEW_KEY = ["position_id", "engine", "depth", "nodes", "time_ms", "fingerprint"]
# SQLite has no ALTER for constraints and reflects the old unnamed UNIQUE
# without a name, so the batch rebuild drops it under a naming-convention name.
_UQ_RENAME = {"uq": "uq_%(table_name)s_%(column_0_name)s"}


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()

    # Phase 1: add the column nullable and backfill every row with the
    # fingerprint of what is already stored.
    op.add_column(
        "engine_evaluations", sa.Column("fingerprint", sa.Text(), nullable=True)
    )
    # Keyset pages bound Python memory. Executemany batches avoid one driver
    # round trip per row; the migration remains one DDL transaction, so this does
    # not shorten PostgreSQL's schema-lock lifetime by committing partial work.
    last_id = None
    while True:
        predicate = " WHERE e.id > :last_id" if last_id is not None else ""
        rows = bind.execute(
            sa.text(
                "SELECT e.id, e.engine, p.fen, e.depth, e.nodes, e.time_ms,"
                " e.score_cp, e.mate_in, e.best_move_uci, e.pv,"
                " e.wdl_win, e.wdl_draw, e.wdl_loss"
                " FROM engine_evaluations e JOIN positions p ON p.id = e.position_id"
                + predicate + " ORDER BY e.id LIMIT 500"
            ),
            {"last_id": last_id} if last_id is not None else {},
        ).mappings().all()
        if not rows:
            break
        updates = []
        for row in rows:
            fingerprint = codec.evaluation_fingerprint(
                engine=row["engine"],
                position_fen=row["fen"],
                depth=row["depth"],
                nodes=row["nodes"],
                time_ms=row["time_ms"],
                score_cp=row["score_cp"],
                mate_in=row["mate_in"],
                best_move_uci=row["best_move_uci"],
                pv=row["pv"],
                wdl_win=row["wdl_win"],
                wdl_draw=row["wdl_draw"],
                wdl_loss=row["wdl_loss"],
            )
            updates.append({"fingerprint": fingerprint, "id": row["id"]})
        bind.execute(
            sa.text("UPDATE engine_evaluations SET fingerprint = :fingerprint WHERE id = :id"),
            updates,
        )
        last_id = rows[-1]["id"]

    # Phase 2: NOT NULL + swap the unique constraint. Rows were unique on the
    # old 5-tuple, so the backfilled 6-tuple is unique too and the swap is safe.
    if bind.dialect.name == "postgresql":
        inspector = sa.inspect(bind)
        for unique in inspector.get_unique_constraints("engine_evaluations"):
            if list(unique.get("column_names") or []) == _OLD_KEY and unique.get("name"):
                op.drop_constraint(unique["name"], "engine_evaluations", type_="unique")
        op.execute(
            sa.text(
                "ALTER TABLE engine_evaluations ALTER COLUMN fingerprint SET NOT NULL"
            )
        )
        op.create_unique_constraint(
            "uq_engine_evaluations_identity", "engine_evaluations", _NEW_KEY
        )
    else:
        with op.batch_alter_table(
            "engine_evaluations", naming_convention=_UQ_RENAME
        ) as batch:
            batch.drop_constraint("uq_engine_evaluations_position_id", type_="unique")
            batch.alter_column("fingerprint", nullable=False)
            batch.create_unique_constraint("uq_engine_evaluations_identity", _NEW_KEY)


def downgrade() -> None:
    """Downgrade schema.

    Lossy by nature: two immutable snapshots sharing one old cache identity
    collapse into the oldest row. Every reference is re-pointed to the
    surviving row first, so nothing is orphaned.
    """
    bind = op.get_bind()
    duplicates = bind.execute(
        sa.text(
            "SELECT position_id, engine, depth, nodes, time_ms FROM engine_evaluations"
            " GROUP BY position_id, engine, depth, nodes, time_ms HAVING COUNT(*) > 1"
        )
    ).all()
    for position_id, engine, depth, nodes, time_ms in duplicates:
        ids = [
            row[0]
            for row in bind.execute(
                sa.text(
                    "SELECT id FROM engine_evaluations"
                    " WHERE position_id = :p AND engine = :e AND depth = :d"
                    " AND nodes = :n AND time_ms = :t ORDER BY id"
                ),
                {"p": position_id, "e": engine, "d": depth, "n": nodes, "t": time_ms},
            ).all()
        ]
        keep_id, drop_ids = ids[0], ids[1:]
        for drop_id in drop_ids:
            for table, column in (
                ("moves", "engine_eval_before_id"),
                ("moves", "engine_eval_after_id"),
                ("moves", "best_move_eval_id"),
                ("opening_nodes", "engine_evaluation_id"),
            ):
                bind.execute(
                    sa.text(
                        "UPDATE {0} SET {1} = :keep WHERE {1} = :drop_id".format(
                            table, column
                        )
                    ),
                    {"keep": keep_id, "drop_id": drop_id},
                )
            bind.execute(
                sa.text("DELETE FROM engine_evaluations WHERE id = :id"),
                {"id": drop_id},
            )

    if bind.dialect.name == "postgresql":
        op.drop_constraint(
            "uq_engine_evaluations_identity", "engine_evaluations", type_="unique"
        )
        op.execute(
            sa.text(
                "ALTER TABLE engine_evaluations ALTER COLUMN fingerprint DROP NOT NULL"
            )
        )
        op.drop_column("engine_evaluations", "fingerprint")
        op.execute(
            sa.text(
                "ALTER TABLE engine_evaluations ADD CONSTRAINT "
                "engine_evaluations_position_id_engine_depth_nodes_time_ms_key "
                "UNIQUE (position_id, engine, depth, nodes, time_ms)"
            )
        )
    else:
        with op.batch_alter_table("engine_evaluations") as batch:
            batch.drop_constraint("uq_engine_evaluations_identity", type_="unique")
            batch.drop_column("fingerprint")
            batch.create_unique_constraint(
                "uq_engine_evaluations_position_id", _OLD_KEY
            )
