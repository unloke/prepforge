"""Remove unused server-side repertoire generation settings."""
from alembic import op

revision = "b82d4f9031ac"
down_revision = "a73c9e8124bf"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("repertoires") as batch_op:
        for name in (
            "main_engine", "human_model", "branch_depth",
            "opponent_branch_threshold", "sub_branch_threshold",
            "max_total_nodes", "max_line_length",
        ):
            batch_op.drop_column(name)
    op.drop_table("engine_settings")
    op.drop_table("app_settings")


def downgrade():
    raise RuntimeError("Discarded server generation settings cannot be restored")
