"""Store position keys and PVs as packed bytes."""
from alembic import op
import sqlalchemy as sa

from prepforge_chess.storage import codec

revision = "c4e6a8b0d2f3"
down_revision = "a1c3e5f7b9d2"
branch_labels = None
depends_on = None

# Keyset pages bound memory, while executemany writes avoid one database round
# trip per row. The whole revision still runs in Alembic's single transaction.
_BATCH = 500


def _convert(table, source, target, transform):
    rows = sa.table(table, sa.column("id", sa.Integer), sa.column(source), sa.column(target))
    conn = op.get_bind()
    last = 0
    while True:
        batch = conn.execute(
            sa.select(rows.c.id, rows.c[source]).where(rows.c.id > last).order_by(rows.c.id).limit(_BATCH)
        ).all()
        if not batch:
            return
        updates = [
            {"row_id": row_id, "value": transform(value)}
            for row_id, value in batch
        ]
        conn.execute(
            sa.update(rows)
            .where(rows.c.id == sa.bindparam("row_id"))
            .values({target: sa.bindparam("value")}),
            updates,
        )
        last = batch[-1][0]


_EVALUATION_REFS = (
    ("moves", "engine_eval_before_id"),
    ("moves", "engine_eval_after_id"),
    ("moves", "best_move_eval_id"),
    ("opening_nodes", "engine_evaluation_id"),
)


def _pack_evaluations():
    conn = op.get_bind()
    evaluations = sa.table(
        "engine_evaluations",
        sa.column("id", sa.Integer),
        sa.column("fingerprint", sa.LargeBinary),
        sa.column("pv_packed", sa.LargeBinary),
    )
    last = 0
    while True:
        batch = conn.execute(sa.text(
            "SELECT e.id, p.fen, e.fingerprint, e.engine, e.depth, e.nodes, e.time_ms,"
            " e.score_cp, e.mate_in, e.best_move_uci, e.pv, e.wdl_win, e.wdl_draw, e.wdl_loss"
            " FROM engine_evaluations e JOIN positions p ON p.id = e.position_id"
            " WHERE e.id > :last ORDER BY e.id LIMIT :limit"
        ), {"last": last, "limit": _BATCH}).mappings().all()
        if not batch:
            return
        prepared = []
        for row in batch:
            fields = dict(row)
            row_id = fields.pop("id")
            old_fingerprint = fields.pop("fingerprint")
            fen = fields.pop("fen")
            packed = codec.pack_pv(fields.pop("pv").split())
            fingerprint = codec.fingerprint_bytes(codec.evaluation_fingerprint(
                position_fen=fen, pv=" ".join(codec.unpack_pv(packed)), **fields,
            ))
            prepared.append((row_id, old_fingerprint, packed, fingerprint))

        changed = {
            fingerprint
            for _row_id, old_fingerprint, _packed, fingerprint in prepared
            if fingerprint != old_fingerprint
        }
        canonical = {}
        if changed:
            canonical = {
                fingerprint: row_id
                for row_id, fingerprint in conn.execute(sa.select(
                    evaluations.c.id, evaluations.c.fingerprint,
                ).where(evaluations.c.fingerprint.in_(changed))).all()
            }

        reference_updates = {key: [] for key in _EVALUATION_REFS}
        updates = []
        deletes = []
        for row_id, old_fingerprint, packed, fingerprint in prepared:
            keep_id = None if fingerprint == old_fingerprint else canonical.get(fingerprint)
            if keep_id is not None:
                # The canonical digest already exists. Redirect its references
                # before removing the duplicate so no move loses its evaluation.
                for key in _EVALUATION_REFS:
                    reference_updates[key].append({"keep": keep_id, "drop": row_id})
                deletes.append({"row_id": row_id})
                continue
            canonical[fingerprint] = row_id
            updates.append({"row_id": row_id, "packed": packed, "fingerprint": fingerprint})

        for (table, column), params in reference_updates.items():
            if params:
                conn.execute(sa.text(
                    f"UPDATE {table} SET {column} = :keep WHERE {column} = :drop"
                ), params)
        if updates:
            conn.execute(
                evaluations.update()
                .where(evaluations.c.id == sa.bindparam("row_id"))
                .values(pv_packed=sa.bindparam("packed"), fingerprint=sa.bindparam("fingerprint")),
                updates,
            )
        if deletes:
            conn.execute(evaluations.delete().where(evaluations.c.id == sa.bindparam("row_id")), deletes)
        last = batch[-1]["id"]


def _swap(table, old, new, new_type, transform, unique=None):
    op.add_column(table, sa.Column(new, new_type))
    _convert(table, old, new, transform)
    with op.batch_alter_table(table) as batch_op:
        batch_op.drop_column(old)
        batch_op.alter_column(new, existing_type=new_type, nullable=False)
        if unique:
            batch_op.create_unique_constraint(unique, [new])


def upgrade():
    op.add_column("engine_evaluations", sa.Column("pv_packed", sa.LargeBinary()))
    _pack_evaluations()
    with op.batch_alter_table("engine_evaluations") as batch_op:
        batch_op.drop_column("pv")
        batch_op.alter_column("pv_packed", new_column_name="pv", existing_type=sa.LargeBinary(), nullable=False)
    _swap("positions", "fen", "key", sa.LargeBinary(), codec.pack_position, "uq_positions_key")


def downgrade():
    _swap("positions", "key", "fen", sa.Text(), codec.unpack_position, "positions_fen_key")
    op.add_column("engine_evaluations", sa.Column("pv_text", sa.Text()))
    _convert("engine_evaluations", "pv", "pv_text", lambda blob: " ".join(codec.unpack_pv(blob)))
    with op.batch_alter_table("engine_evaluations") as batch_op:
        batch_op.drop_column("pv")
        batch_op.alter_column("pv_text", new_column_name="pv", existing_type=sa.Text(), nullable=False)
