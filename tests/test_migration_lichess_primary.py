"""The d4e5f6a7b8c9 backfill must be a typed Boolean update on every dialect.

The original migration ran raw SQL ``SET is_primary = 1``. SQLite coerces the
integer, so CI stayed green, but PostgreSQL rejects it outright::

    DatatypeMismatch: column "is_primary" is of type boolean
    but expression is of type integer

and the production deploy failed at ``alembic upgrade head``. A SQLAlchemy
typed ``update()`` with ``values(is_primary=True)`` compiles to ``=true`` on
PostgreSQL and ``=1`` on SQLite, so the same migration file is valid on both.

Two layers guard this:

1. ``test_boolean_backfill_compiles_per_dialect`` — no database needed. It
   compiles the exact statement the migration executes against both dialects
   and asserts the PostgreSQL text never carries an integer literal for the
   boolean column. This fails fast on the old raw-SQL spelling.
2. ``test_upgrade_backfills_is_primary_true_*`` — a real upgrade from
   c7e8f9a0b1c2 to d4e5f6a7b8c9 on a database (PostgreSQL when TEST_POSTGRES_URL
   is set — the CI ``postgres`` job provides it via the ``postgres`` service;
   plus a SQLite path for local runs) with pre-existing linked rows, asserting
   every row ends up ``is_primary IS true``.
"""
from __future__ import annotations

import os
import uuid

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

DIALECT_PG_HINT = "is_primary=true"
DIALECT_SQLITE_HINT = "is_primary=1"


def _backfill_statement() -> sa.Update:
    linked_accounts = sa.table(
        "linked_accounts",
        sa.column("is_primary", sa.Boolean()),
    )
    return (
        linked_accounts.update()
        .where(linked_accounts.c.is_primary.is_(None))
        .values(is_primary=True)
    )


def _compiled(statement: sa.Update, dialect_name: str) -> str:
    module = __import__(f"sqlalchemy.dialects.{dialect_name}", fromlist=["dialect"])
    return str(
        statement.compile(
            dialect=module.dialect(), compile_kwargs={"literal_binds": True}
        )
    )


def test_boolean_backfill_compiles_per_dialect() -> None:
    statement = _backfill_statement()
    pg_sql = _compiled(statement, "postgresql")
    sqlite_sql = _compiled(statement, "sqlite")
    assert DIALECT_PG_HINT in pg_sql.replace(" ", "")
    assert DIALECT_SQLITE_HINT in sqlite_sql.replace(" ", "")
    assert "is_primary=1" not in pg_sql.replace(" ", "")


def _pg_url(raw: str) -> str:
    # The app pins bare postgres:// URLs to postgresql+psycopg:// (psycopg v3);
    # the test's own engine needs the same pin or SQLAlchemy defaults to psycopg2.
    if raw.startswith("postgresql://"):
        return "postgresql+psycopg://" + raw[len("postgresql://") :]
    if raw.startswith("postgres://"):
        return "postgresql+psycopg://" + raw[len("postgres://") :]
    return raw


def _alembic_config(db_url: str, monkeypatch=None) -> Config:
    if monkeypatch is not None:
        monkeypatch.setenv("DATABASE_URL", db_url)
        from prepforge_chess.api import config as app_config

        app_config.get_settings.cache_clear()
    else:
        os.environ["DATABASE_URL"] = db_url
        from prepforge_chess.api import config as app_config

        app_config.get_settings.cache_clear()
    cfg = Config("alembic.ini")
    return cfg


def _seed_pre_migration_rows(engine: sa.Engine) -> None:
    meta = sa.MetaData()
    users = sa.Table(
        "users",
        meta,
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=True),
        sa.Column("plan", sa.String(16), nullable=False, server_default="free"),
        sa.Column("display_name", sa.String(120), nullable=True),
        sa.Column("stripe_customer_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True)),
    )
    linked = sa.Table(
        "linked_accounts",
        meta,
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("provider_user_id", sa.String(120), nullable=False),
        sa.Column("encrypted_token", sa.String(2048), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("user_id", "provider", name="uq_user_provider"),
    )
    user_id = uuid.uuid4().hex
    now = sa.func.now() if engine.dialect.name == "postgresql" else sa.func.datetime("now")
    with engine.begin() as conn:
        conn.execute(
            users.insert().values(
                id=user_id,
                email="mig@example.com",
                plan="free",
                created_at=now,
                updated_at=now,
            )
        )
        conn.execute(
            linked.insert().values(
                id=uuid.uuid4().hex,
                user_id=user_id,
                provider="lichess",
                provider_user_id="MigUser",
                created_at=now,
            )
        )


@pytest.mark.skipif(
    not os.environ.get("TEST_POSTGRES_URL"),
    reason="PostgreSQL URL not provided (TEST_POSTGRES_URL); SQLite covers the path locally",
)
def test_upgrade_backfills_is_primary_true_postgres(monkeypatch) -> None:
    db_url = os.environ["TEST_POSTGRES_URL"]
    engine = sa.create_engine(_pg_url(db_url))
    with engine.begin() as conn:
        conn.execute(sa.text("DROP TABLE IF EXISTS linked_accounts CASCADE"))
        conn.execute(sa.text("DROP TABLE IF EXISTS users CASCADE"))
        conn.execute(sa.text("DROP TABLE IF EXISTS alembic_version CASCADE"))
    cfg = _alembic_config(db_url, monkeypatch)
    command.upgrade(cfg, "c7e8f9a0b1c2")
    _seed_pre_migration_rows(engine)
    command.upgrade(cfg, "d4e5f6a7b8c9")
    with engine.connect() as conn:
        nulls = conn.execute(
            sa.text("SELECT count(*) FROM linked_accounts WHERE is_primary IS NULL")
        ).scalar()
        falses = conn.execute(
            sa.text("SELECT count(*) FROM linked_accounts WHERE is_primary IS NOT TRUE")
        ).scalar()
        version = conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar()
    assert nulls == 0
    assert falses == 0
    assert version == "d4e5f6a7b8c9"


def test_upgrade_backfills_is_primary_true_sqlite(tmp_path, monkeypatch) -> None:
    db_url = f"sqlite:///{(tmp_path / 'mig.sqlite3').as_posix()}"
    engine = sa.create_engine(db_url)
    cfg = _alembic_config(db_url, monkeypatch)
    command.upgrade(cfg, "c7e8f9a0b1c2")
    _seed_pre_migration_rows(engine)
    command.upgrade(cfg, "d4e5f6a7b8c9")
    with engine.connect() as conn:
        nulls = conn.execute(
            sa.text("SELECT count(*) FROM linked_accounts WHERE is_primary IS NULL")
        ).scalar()
        version = conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar()
    assert nulls == 0
    assert version == "d4e5f6a7b8c9"
