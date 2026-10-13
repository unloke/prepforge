"""Enforce owner foreign keys on games, repertoires, training_progress, user_settings.

These owner columns were plain text, so deleting a user row left its content
behind unless the account-deletion code path ran. With the FK, the database
cascades the delete itself.

The migration refuses to run if any owner row points at a missing user: adding
the constraint would fail on Postgres and would silently orphan data on SQLite.
Clean up such rows deliberately, then re-run.

Revision ID: e7a1c3d5f9b2
Revises: d4e6f8a0b2c3
"""
from alembic import context, op
import sqlalchemy as sa

revision = "e7a1c3d5f9b2"
down_revision = "d4e6f8a0b2c3"
branch_labels = None
depends_on = None

# (table, owner column, constraint name)
OWNER_FKS = (
    ("games", "owner_user_id", "fk_games_owner_user_id"),
    ("repertoires", "owner_user_id", "fk_repertoires_owner_user_id"),
    ("training_progress", "owner_user_id", "fk_training_progress_owner_user_id"),
    ("user_settings", "user_id", "fk_user_settings_user_id"),
)


def _refuse_orphans(bind) -> None:
    problems = {}
    for table, column, _name in OWNER_FKS:
        count = bind.execute(sa.text(
            f"SELECT COUNT(*) FROM {table} WHERE {column} IS NOT NULL "
            f"AND {column} NOT IN (SELECT id FROM users)"
        )).scalar()
        if count:
            problems[f"{table}.{column}"] = count
    if problems:
        raise RuntimeError(
            "Owner rows reference missing users; delete or reassign them before "
            f"this migration: {problems}"
        )


def upgrade() -> None:
    # Offline (--sql) runs have no connection to count orphans on; the online run
    # performs the check before any table is rebuilt.
    if not context.is_offline_mode():
        _refuse_orphans(op.get_bind())
    for table, column, name in OWNER_FKS:
        with op.batch_alter_table(table) as batch:
            batch.create_foreign_key(name, "users", [column], ["id"], ondelete="CASCADE")


def downgrade() -> None:
    for table, _column, name in OWNER_FKS:
        with op.batch_alter_table(table) as batch:
            batch.drop_constraint(name, type_="foreignkey")
