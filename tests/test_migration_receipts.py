import os
import uuid

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from prepforge_chess.api.config import get_settings


@pytest.fixture(params=["sqlite", "postgres"])
def migrated_database(request, tmp_path, monkeypatch):
    admin = None
    schema = None
    if request.param == "postgres":
        raw = os.getenv("TEST_POSTGRES_URL")
        if not raw:
            pytest.skip("TEST_POSTGRES_URL requires real PostgreSQL")
        url = raw.replace("postgresql://", "postgresql+psycopg://", 1)
        schema = "receipts_" + uuid.uuid4().hex[:16]
        admin = sa.create_engine(url, isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
        monkeypatch.setenv("PGOPTIONS", "-c search_path=" + schema)
    else:
        url = "sqlite:///" + str(tmp_path / "receipt-migration.sqlite3")
    monkeypatch.setenv("DATABASE_URL", url)
    get_settings.cache_clear()
    cfg = Config("alembic.ini")
    engine = sa.create_engine(url)
    try:
        command.upgrade(cfg, "f7a9b1c3d5e7")
        yield cfg, engine
    finally:
        engine.dispose()
        get_settings.cache_clear()
        if admin:
            with admin.connect() as conn:
                conn.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
            admin.dispose()


def test_receipt_upgrade_and_downgrade_never_truncate(migrated_database):
    cfg, engine = migrated_database
    key = "receipt-migration"
    with engine.begin() as conn:
        conn.execute(sa.text("INSERT INTO user_settings (user_id,key,value_json,updated_at) VALUES (:owner,:key,:value,CURRENT_TIMESTAMP)"),
                     {"owner": "owner", "key": key, "value": '"small"'})
    command.upgrade(cfg, "a73c9e8124bf")
    large = '"' + "x" * 50000 + '"'
    with engine.begin() as conn:
        assert conn.scalar(sa.text("SELECT value_json FROM user_settings WHERE key=:key"), {"key": key}) == '"small"'
        conn.execute(sa.text("UPDATE user_settings SET value_json=:value WHERE key=:key"), {"value": large, "key": key})
    with pytest.raises(RuntimeError, match="receipt payloads exceed 4000"):
        command.downgrade(cfg, "f7a9b1c3d5e7")
    with engine.begin() as conn:
        assert conn.scalar(sa.text("SELECT value_json FROM user_settings WHERE key=:key"), {"key": key}) == large
        assert conn.scalar(sa.text("SELECT version_num FROM alembic_version")) == "a73c9e8124bf"
        conn.execute(sa.text("UPDATE user_settings SET value_json=:value WHERE key=:key"), {"value": '"small"', "key": key})
    command.downgrade(cfg, "f7a9b1c3d5e7")
    command.upgrade(cfg, "a73c9e8124bf")
    with engine.connect() as conn:
        assert conn.scalar(sa.text("SELECT value_json FROM user_settings WHERE key=:key"), {"key": key}) == '"small"'
