"""Generated explanations, analysis quality, revision + share governance, reset tokens

Revision ID: e5a7c9d21b3f
Revises: f3a9c1e7b2d4
Create Date: 2026-09-30 00:00:00.000000

One migration for the improvement-review batch:

* ``moves.generated_comment`` / ``moves.generated_meta_json`` — the classifier's
  explanation is stored APART from the original/user comment and replaced on
  re-analysis (A-04: explanations can no longer accumulate across runs).
* ``analysis_results.quality_json`` — target vs actual search depth, shallow
  spots, Maia status, algorithm versions (A-05).
* ``repertoires.revision`` — bumped on every tree/metadata mutation so Build
  mutations can send ``base_revision`` and get 409 on stale writes (D-02).
* ``repertoires.share_rev`` / ``share_enabled`` / ``share_expires_at`` —
  public share links become independently revocable/rotatable/expiring (F-01).
  Existing rows default to ``share_rev=0, share_enabled=1`` so pre-existing
  links keep working until the owner revokes or rotates.
* ``password_reset_tokens`` — single-use, expiring password recovery (F-02);
  only the SHA-256 of the token is stored.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e5a7c9d21b3f'
down_revision: Union[str, Sequence[str], None] = 'f3a9c1e7b2d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('moves', schema=None) as batch_op:
        batch_op.add_column(sa.Column('generated_comment', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('generated_meta_json', sa.Text(), nullable=True))

    with op.batch_alter_table('analysis_results', schema=None) as batch_op:
        batch_op.add_column(sa.Column('quality_json', sa.Text(), nullable=True))

    with op.batch_alter_table('repertoires', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('revision', sa.Integer(), nullable=False, server_default='0')
        )
        batch_op.add_column(
            sa.Column('share_rev', sa.Integer(), nullable=False, server_default='0')
        )
        batch_op.add_column(
            sa.Column('share_enabled', sa.Integer(), nullable=False, server_default='1')
        )
        batch_op.add_column(
            sa.Column('share_expires_at', sa.Text(), nullable=True)
        )

    op.create_table(
        'password_reset_tokens',
        sa.Column('id', sa.String(length=32), primary_key=True),
        sa.Column(
            'user_id',
            sa.String(length=32),
            sa.ForeignKey('users.id', ondelete='CASCADE'),
            nullable=False,
        ),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        # NOT NULL like the ORM model (``PasswordResetToken.created_at``);
        # `alembic check` compares both and must see zero drift.
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        'ix_password_reset_tokens_user_id', 'password_reset_tokens', ['user_id']
    )
    op.create_index(
        'ix_password_reset_tokens_token_hash',
        'password_reset_tokens',
        ['token_hash'],
        unique=True,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_password_reset_tokens_token_hash', table_name='password_reset_tokens')
    op.drop_index('ix_password_reset_tokens_user_id', table_name='password_reset_tokens')
    op.drop_table('password_reset_tokens')

    with op.batch_alter_table('repertoires', schema=None) as batch_op:
        batch_op.drop_column('share_expires_at')
        batch_op.drop_column('share_enabled')
        batch_op.drop_column('share_rev')
        batch_op.drop_column('revision')

    with op.batch_alter_table('analysis_results', schema=None) as batch_op:
        batch_op.drop_column('quality_json')

    with op.batch_alter_table('moves', schema=None) as batch_op:
        batch_op.drop_column('generated_meta_json')
        batch_op.drop_column('generated_comment')
