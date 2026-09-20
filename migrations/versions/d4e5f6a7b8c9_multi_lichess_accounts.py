"""allow multiple linked lichess accounts per user

Revision ID: d4e5f6a7b8c9
Revises: c7e8f9a0b1c2
Create Date: 2026-09-20

Replace the single-account ``uq_user_provider`` constraint with
``uq_user_provider_identity`` (user_id, provider, provider_user_id) and add a
per-user ``is_primary`` flag so one linked Lichess identity can serve as the
default for My-last-game / compare / explorer reads.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, Sequence[str], None] = "c7e8f9a0b1c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("linked_accounts", schema=None) as batch_op:
        batch_op.add_column(sa.Column("is_primary", sa.Boolean(), nullable=True))
        batch_op.drop_constraint("uq_user_provider", type_="unique")
        batch_op.create_unique_constraint(
            "uq_user_provider_identity", ["user_id", "provider", "provider_user_id"]
        )

    op.execute("UPDATE linked_accounts SET is_primary = 1 WHERE is_primary IS NULL")

    with op.batch_alter_table("linked_accounts", schema=None) as batch_op:
        batch_op.alter_column("is_primary", existing_type=sa.Boolean(), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("linked_accounts", schema=None) as batch_op:
        batch_op.drop_constraint("uq_user_provider_identity", type_="unique")
        batch_op.create_unique_constraint("uq_user_provider", ["user_id", "provider"])
        batch_op.drop_column("is_primary")
