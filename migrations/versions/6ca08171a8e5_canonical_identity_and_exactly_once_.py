"""canonical identity and exactly-once train

Revision ID: 6ca08171a8e5
Revises: d4e5f6a7b8c9
Create Date: 2026-09-22 10:47:29.122590

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6ca08171a8e5'
down_revision: Union[str, Sequence[str], None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('train_attempt_receipts',
    sa.Column('session_id', sa.String(length=64), nullable=False),
    sa.Column('attempt_uuid', sa.String(length=64), nullable=False),
    sa.Column('node_id', sa.String(length=64), nullable=False),
    sa.Column('correct', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.String(length=64), nullable=False),
    sa.PrimaryKeyConstraint('session_id', 'attempt_uuid')
    )
    with op.batch_alter_table('train_attempt_receipts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_train_attempt_receipts_session_id'), ['session_id'], unique=False)

    op.create_table('user_settings',
    sa.Column('user_id', sa.String(length=32), nullable=False),
    sa.Column('key', sa.String(length=120), nullable=False),
    sa.Column('value_json', sa.String(length=4000), nullable=False),
    sa.Column('updated_at', sa.String(length=64), nullable=False),
    sa.PrimaryKeyConstraint('user_id', 'key')
    )
    # user_settings.user_id is a plain owner id (no DB-level FK): ephemeral
    # SQLite helpers create domain tables without the identity tables, and
    # ownership is enforced in application code (current_owner gates).
    with op.batch_alter_table('user_settings', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_user_settings_user_id'), ['user_id'], unique=False)

    # Re-key owner columns off users.id before dropping user_profiles. SQLite
    # needs batch table recreation to drop the old FK column. PostgreSQL must
    # alter these tables in place: recreating repertoires would drop its PK,
    # which is referenced by opening_nodes and the training tables.
    bind = op.get_bind()
    if bind.dialect.name == 'postgresql':
        for table in ('repertoires', 'training_progress'):
            foreign_keys = sa.inspect(bind).get_foreign_keys(table)
            for foreign_key in foreign_keys:
                if foreign_key['constrained_columns'] == ['user_profile_id']:
                    op.drop_constraint(foreign_key['name'], table, type_='foreignkey')

        op.add_column('repertoires', sa.Column('owner_user_id', sa.Text(), nullable=True))
        op.drop_index('idx_repertoires_owner', table_name='repertoires')
        op.create_index('idx_repertoires_owner', 'repertoires', ['owner_user_id'], unique=False)
        op.drop_column('repertoires', 'user_profile_id')

        op.add_column('training_progress', sa.Column('owner_user_id', sa.Text(), nullable=True))
        op.drop_index('idx_training_progress_rep_user', table_name='training_progress')
        op.create_index(
            'idx_training_progress_rep_user',
            'training_progress',
            ['repertoire_id', 'owner_user_id'],
            unique=False,
        )
        op.create_unique_constraint(
            'uq_training_progress_owner',
            'training_progress',
            ['owner_user_id', 'repertoire_id', 'node_id'],
        )
        op.drop_column('training_progress', 'user_profile_id')
    else:
        with op.batch_alter_table('repertoires', schema=None, recreate='always') as batch_op:
            batch_op.add_column(sa.Column('owner_user_id', sa.Text(), nullable=True))
            batch_op.drop_index('idx_repertoires_owner')
            batch_op.create_index('idx_repertoires_owner', ['owner_user_id'], unique=False)
            batch_op.drop_column('user_profile_id')

        with op.batch_alter_table('training_progress', schema=None, recreate='always') as batch_op:
            batch_op.add_column(sa.Column('owner_user_id', sa.Text(), nullable=True))
            batch_op.drop_index('idx_training_progress_rep_user')
            batch_op.create_index('idx_training_progress_rep_user', ['repertoire_id', 'owner_user_id'], unique=False)
            batch_op.create_unique_constraint('uq_training_progress_owner', ['owner_user_id', 'repertoire_id', 'node_id'])
            batch_op.drop_column('user_profile_id')

    with op.batch_alter_table('user_sessions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('idx_user_sessions_profile'))

    op.drop_table('user_sessions')
    op.drop_table('user_profiles')


def downgrade() -> None:
    """This destructive pre-user identity reset cannot restore dropped data."""
    raise NotImplementedError("canonical identity migration is irreversible")
