"""team_invites + normalize classroom kind

Revision ID: 4cf98dc84ece
Revises: f9b380126b7b
Create Date: 2026-06-17 05:27:41.786604

Adds the ``team_invites`` table (one hashed, revocable join code per team) and
normalizes the now-retired ``teams.kind`` so every existing team is a plain
``team`` (the Classroom concept was removed). The ``kind`` column itself is left
in place (vestigial, always ``team``) to avoid a destructive column drop.

NOTE: autogenerate also flags ``idx_training_progress_rep_user`` /
``idx_training_sessions_rep_mode_updated`` as missing -- those legacy performance
indexes are created at runtime by ``storage.database._ensure_indexes`` (by design,
"without an Alembic migration"), so they are intentionally NOT created here:
``create_index`` would fail on deployments where ``_ensure_indexes`` already made
them.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4cf98dc84ece'
down_revision: Union[str, Sequence[str], None] = 'f9b380126b7b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'team_invites',
        sa.Column('id', sa.String(length=32), nullable=False),
        sa.Column('team_id', sa.String(length=32), nullable=False),
        sa.Column('code_hash', sa.String(length=64), nullable=False),
        sa.Column('created_by_user_id', sa.String(length=32), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['created_by_user_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('team_invites', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_team_invites_code_hash'), ['code_hash'], unique=True)
        batch_op.create_index(batch_op.f('ix_team_invites_team_id'), ['team_id'], unique=True)

    # Retire the Classroom concept: every existing team becomes a plain team.
    op.execute("UPDATE teams SET kind='team' WHERE kind='classroom'")


def downgrade() -> None:
    """Downgrade schema. (The one-way kind normalization is not reversed.)"""
    with op.batch_alter_table('team_invites', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_team_invites_team_id'))
        batch_op.drop_index(batch_op.f('ix_team_invites_code_hash'))

    op.drop_table('team_invites')
