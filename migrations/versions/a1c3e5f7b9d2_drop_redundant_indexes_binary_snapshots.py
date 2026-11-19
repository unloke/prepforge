"""Drop indexes their table's primary or unique key already covers; store analysis snapshots as raw zlib bytes."""
from alembic import op
import sqlalchemy as sa

revision = "a1c3e5f7b9d2"
down_revision = "8e4a6c2d0f91"
branch_labels = None
depends_on = None

_REDUNDANT = (
    ("linked_accounts", "ix_linked_accounts_user_id", ["user_id"]),
    ("team_members", "ix_team_members_team_id", ["team_id"]),
    ("user_settings", "ix_user_settings_user_id", ["user_id"]),
    ("train_attempt_receipts", "ix_train_attempt_receipts_session_id", ["session_id"]),
    ("games", "idx_games_owner", ["owner_user_id"]),
    ("moves", "idx_moves_game_ply", ["game_id", "ply"]),
)


def upgrade():
    for table, name, _columns in _REDUNDANT:
        op.drop_index(name, table_name=table)
    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.drop_column("move_results_json")
        batch_op.add_column(sa.Column("move_results", sa.LargeBinary()))


def downgrade():
    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.drop_column("move_results")
        batch_op.add_column(sa.Column("move_results_json", sa.Text()))
    for table, name, columns in _REDUNDANT:
        op.create_index(name, table, columns)
