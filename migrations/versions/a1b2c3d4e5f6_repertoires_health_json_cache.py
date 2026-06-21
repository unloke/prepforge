"""repertoires.health_json cache column

Revision ID: a1b2c3d4e5f6
Revises: 4cf98dc84ece
Create Date: 2026-06-21 00:00:00.000000

Adds a nullable ``health_json`` column to ``repertoires``: a denormalized
``RepertoireHealth.to_dict()`` blob refreshed wherever the opening tree is already
loaded (the Build workspace payload and the train smart-session summary). It lets
the dashboard repertoire list render its coverage badge from a single cheap row read
instead of loading every repertoire's tree and walking it per request (the N+1 +
per-row ``compute_health`` walk that the lightweight listing removed). NULL means the
health was never computed for that row yet; it self-heals the first time the
repertoire is opened in Build or trained.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '4cf98dc84ece'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('repertoires', schema=None) as batch_op:
        batch_op.add_column(sa.Column('health_json', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('repertoires', schema=None) as batch_op:
        batch_op.drop_column('health_json')
