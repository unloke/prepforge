"""Version training session state independently of attempt receipts."""
from alembic import op
import sqlalchemy as sa

revision = "d39f7ca50812"
down_revision = "c28e6b94f701"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("training_sessions", sa.Column(
        "state_version", sa.Integer(), nullable=False, server_default="0"))


def downgrade():
    op.drop_column("training_sessions", "state_version")
