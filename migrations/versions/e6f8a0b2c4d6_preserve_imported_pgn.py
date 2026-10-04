"""Retain imported PGN annotations and variations alongside compact moves."""
from alembic import op
import sqlalchemy as sa

revision = "e6f8a0b2c4d6"
down_revision = "d39f7ca50812"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("games", sa.Column("pgn", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("games", "pgn")
