"""training_progress.due_at index

Revision ID: b7d21c93e4a8
Revises: 6ca08171a8e5
Create Date: 2026-09-27 00:00:00.000000

``due_at`` (ISO-8601 UTC text) is the dashboard's due-review filter
(``due_at <= now`` over the owner's progress rows) and the scheduler's primary
sort key. It was the one hot predicate with no index, so every dashboard load
scanned the owner's progress rows and the gap would grow silently with each
user's repertoire. Lexical comparison is correct for this column because the
timestamps are fixed-format UTC text.

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7d21c93e4a8'
down_revision: Union[str, Sequence[str], None] = '6ca08171a8e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index(
        'idx_training_progress_due', 'training_progress', ['due_at'], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('idx_training_progress_due', table_name='training_progress')
