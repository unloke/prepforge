"""Index import dedupe by a stored move-signature digest.

Adds ``games.move_signature`` (``codec.stored_move_signature``: SHA-256 of the
canonical initial position plus the UCI sequence) with an
``(owner_user_id, move_signature)`` index, and fills it for existing rows.
The downgrade drops both; nothing else reads the column.
"""
from alembic import op
import sqlalchemy as sa

from prepforge_chess.storage import codec

revision = "71a953683595"
down_revision = "c4e6a8b0d2f3"
branch_labels = None
depends_on = None

# Keyset pages bound memory, while executemany writes avoid one database round
# trip per row. The whole revision still runs in Alembic's single transaction.
_BATCH = 500


def _backfill():
    games = sa.table(
        "games",
        sa.column("id", sa.Text),
        sa.column("initial_fen", sa.Text),
        sa.column("uci_blob", sa.Text),
        sa.column("move_signature", sa.LargeBinary),
    )
    conn = op.get_bind()
    last = ""
    while True:
        batch = conn.execute(
            sa.select(games.c.id, games.c.initial_fen, games.c.uci_blob)
            .where(games.c.id > last)
            .order_by(games.c.id)
            .limit(_BATCH)
        ).all()
        if not batch:
            return
        conn.execute(
            sa.update(games)
            .where(games.c.id == sa.bindparam("row_id"))
            .values(move_signature=sa.bindparam("digest")),
            [
                {"row_id": row_id, "digest": codec.stored_move_signature(fen, blob)}
                for row_id, fen, blob in batch
            ],
        )
        last = batch[-1][0]


def upgrade():
    op.add_column("games", sa.Column("move_signature", sa.LargeBinary()))
    _backfill()
    with op.batch_alter_table("games") as batch_op:
        batch_op.alter_column("move_signature", existing_type=sa.LargeBinary(), nullable=False)
        batch_op.create_index("idx_games_owner_signature", ["owner_user_id", "move_signature"])


def downgrade():
    with op.batch_alter_table("games") as batch_op:
        batch_op.drop_index("idx_games_owner_signature")
        batch_op.drop_column("move_signature")
