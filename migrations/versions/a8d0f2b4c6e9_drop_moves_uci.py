"""Drop moves.uci: the arriving move is games.uci_blob[ply-1].

Revision ID: a8d0f2b4c6e9
Revises: f7c9a1b3d5e8
Create Date: 2026-10-20 00:00:00.000000

``moves`` holds sparse per-ply annotations; the move sequence itself is the
game's ``uci_blob``, and every read rebuilds moves by replaying that blob and
overlaying these rows. ``uci`` was written on every annotated ply and read by
nothing: the row's move is already known from the ply number.
"""
from alembic import op
import sqlalchemy as sa


revision = "a8d0f2b4c6e9"
down_revision = "f7c9a1b3d5e8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("moves", "uci")


def downgrade() -> None:
    # Restorable from the game's blob; the column itself is not data.
    op.add_column("moves", sa.Column("uci", sa.Text(), nullable=True))
