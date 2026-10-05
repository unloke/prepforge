"""Allow durable batch receipts larger than a small preference value."""
from alembic import op
import sqlalchemy as sa

revision = "a73c9e8124bf"
down_revision = "f7a9b1c3d5e7"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("user_settings") as batch:
        batch.alter_column("value_json", existing_type=sa.String(4000),
                           type_=sa.Text(), existing_nullable=False)


def downgrade():
    # A downgrade must not truncate exactly-once receipts. Refuse if any
    # existing value does not fit the old schema.
    connection = op.get_bind()
    oversized = connection.scalar(sa.text(
        "SELECT COUNT(*) FROM user_settings WHERE length(value_json) > 4000"
    ))
    if oversized:
        raise RuntimeError("Cannot downgrade: durable receipt payloads exceed 4000 characters")
    with op.batch_alter_table("user_settings") as batch:
        batch.alter_column("value_json", existing_type=sa.Text(),
                           type_=sa.String(4000), existing_nullable=False)
