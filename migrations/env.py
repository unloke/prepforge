"""Alembic environment.

Wired to the app's Settings (so DATABASE_URL drives both the app and migrations)
and to the SaaS ORM metadata for autogenerate. Importing the models module
registers every table on Base.metadata.
"""
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context

from prepforge_chess.api import models  # noqa: F401  (registers tables on Base.metadata)
from prepforge_chess.api.config import get_settings
from prepforge_chess.api.db import Base
from prepforge_chess.storage import sa_tables  # noqa: F401  (registers legacy tables on Base.metadata)

config = context.config

# Drive the connection URL from app settings rather than the static ini value, so
# one place (DATABASE_URL) controls dev/prod.
config.set_main_option("sqlalchemy.url", get_settings().database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,  # SQLite needs batch mode for ALTER TABLE
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        is_sqlite = connection.dialect.name == "sqlite"
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=is_sqlite,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
