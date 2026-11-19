"""Store position keys and PVs as packed bytes."""
from alembic import op
import sqlalchemy as sa

from prepforge_chess.storage import codec

revision = "c4e6a8b0d2f3"
down_revision = "a1c3e5f7b9d2"
branch_labels = None
depends_on = None

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
        for row_id, value in batch:
            conn.execute(sa.update(rows).where(rows.c.id == row_id).values({target: transform(value)}))
        last = batch[-1][0]


def _pv_bytes(text):
    return codec.pack_pv(text.split())


def _swap(table, old, new, new_type, transform, unique=None):
    op.add_column(table, sa.Column(new, new_type))
    _convert(table, old, new, transform)
    with op.batch_alter_table(table) as batch_op:
        batch_op.drop_column(old)
        batch_op.alter_column(new, existing_type=new_type, nullable=False)
        if unique:
            batch_op.create_unique_constraint(unique, [new])


def upgrade():
    _swap("positions", "fen", "key", sa.LargeBinary(), codec.pack_position, "uq_positions_key")
    op.add_column("engine_evaluations", sa.Column("pv_packed", sa.LargeBinary()))
    _convert("engine_evaluations", "pv", "pv_packed", _pv_bytes)
    with op.batch_alter_table("engine_evaluations") as batch_op:
        batch_op.drop_column("pv")
        batch_op.alter_column("pv_packed", new_column_name="pv", existing_type=sa.LargeBinary(), nullable=False)


def downgrade():
    _swap("positions", "key", "fen", sa.Text(), codec.unpack_position, "positions_fen_key")
    op.add_column("engine_evaluations", sa.Column("pv_text", sa.Text()))
    _convert("engine_evaluations", "pv", "pv_text", lambda blob: " ".join(codec.unpack_pv(blob)))
    with op.batch_alter_table("engine_evaluations") as batch_op:
        batch_op.drop_column("pv")
        batch_op.alter_column("pv_text", new_column_name="pv", existing_type=sa.Text(), nullable=False)
