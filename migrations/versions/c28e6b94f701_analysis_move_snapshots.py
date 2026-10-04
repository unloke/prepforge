"""Bind report moves to their analysis run.

Historical shared annotations cannot be attributed reliably to a run, so old
snapshots remain NULL and require reanalysis to obtain per-move results.
"""
from alembic import op
import sqlalchemy as sa

revision = "c28e6b94f701"
down_revision = "a91d4c2e7b60"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("analysis_results", sa.Column("move_results_json", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("analysis_results", "move_results_json")
