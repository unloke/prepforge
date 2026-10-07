"""Convert ISO text timestamps to UTC DateTime columns.

Revision ID: c2d8e4f6a901
Revises: b82d4f9031ac
"""
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa

revision = "c2d8e4f6a901"
down_revision = "b82d4f9031ac"
branch_labels = None
depends_on = None

TIMESTAMPS = {
    "games": ("played_at", "created_at", "updated_at"),
    "analysis_results": ("analyzed_at",),
    "repertoires": ("created_at", "updated_at", "share_expires_at"),
    "opening_nodes": ("created_at", "updated_at"),
    "training_sessions": ("created_at", "updated_at"),
    "training_progress": ("last_reviewed_at", "due_at", "created_at", "updated_at"),
    "user_settings": ("updated_at",),
    "train_attempt_receipts": ("created_at",),
}

IDENTITY_TIMESTAMPS = {
    "users": ("created_at", "updated_at"),
    "linked_accounts": ("created_at",),
    "teams": ("created_at",),
    "team_members": ("created_at",),
    "team_invites": ("expires_at", "created_at"),
    "password_reset_tokens": ("created_at", "expires_at", "used_at"),
    "stripe_events": ("processed_at",),
    "auth_sessions": ("created_at", "last_seen_at"),
}


def upgrade():
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        # Offset-free historical PGN dates were interpreted as UTC.
        conn.exec_driver_sql("SET LOCAL TIME ZONE 'UTC'")
    timestamps = TIMESTAMPS if conn.dialect.name == "postgresql" else TIMESTAMPS | IDENTITY_TIMESTAMPS
    for name, columns in timestamps.items():
        if conn.dialect.name == "postgresql":
            for column in columns:
                op.alter_column(name, column, type_=sa.DateTime(timezone=True),
                                postgresql_using=f'"{column}"::timestamptz')
            continue

        table = sa.Table(name, sa.MetaData(), autoload_with=conn)
        keys = list(table.primary_key.columns)
        for column in columns:
            table.c[column].type = sa.Text()
        # Normalize offsets and precision before rebuilding: SQLite DATETIME
        # uses a space separator and a fixed UTC suffix for aware ISO parsing.
        rows = conn.execute(sa.select(*keys, *(table.c[c] for c in columns))).mappings()
        for row in rows:
            values = {}
            for column in columns:
                if row[column] is None:
                    continue
                instant = datetime.fromisoformat(row[column])
                if instant.tzinfo is None:
                    instant = instant.replace(tzinfo=timezone.utc)
                values[column] = instant.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f") + "+00:00"
            if values:
                conn.execute(table.update().where(*(key == row[key.name] for key in keys)).values(**values))
        if name in IDENTITY_TIMESTAMPS:
            continue  # Identity columns already have DATETIME affinity.
        # The copy source already has DATETIME affinity. This prevents SQLite's
        # CAST(text AS DATETIME), which would reduce a timestamp to its year.
        for column in columns:
            table.c[column].type = sa.DateTime(timezone=True)
        with op.batch_alter_table(name, copy_from=table, recreate="always") as batch:
            for column in columns:
                batch.alter_column(column, type_=sa.DateTime(timezone=True))


def downgrade():
    raise NotImplementedError("UTC timestamp storage is a forward-only schema change")
