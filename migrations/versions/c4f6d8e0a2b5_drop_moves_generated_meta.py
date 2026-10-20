"""Drop moves.generated_meta_json: per-ply provenance nothing reads.

Revision ID: c4f6d8e0a2b5
Revises: b3e5c7d9f1a4
Create Date: 2026-10-20 00:00:00.000000

Every analysed ply wrote the same run-level blob (algorithm versions, engine,
depth, analyzed_at) into its own column — 176 bytes per move, the largest
column of the ``moves`` table on the measured dataset — and no code path ever
read it back. The versioned provenance of a run already lives once per run in
``analysis_results.quality_json``.
"""
from alembic import op

revision = "c4f6d8e0a2b5"
down_revision = "b3e5c7d9f1a4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("moves", "generated_meta_json")


def downgrade() -> None:
    import sqlalchemy as sa

    op.add_column("moves", sa.Column("generated_meta_json", sa.Text(), nullable=True))
