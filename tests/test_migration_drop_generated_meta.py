"""Forward migration c4f6d8e0a2b5: moves keeps no per-ply provenance blob.

Builds a database at the previous revision with real move rows, upgrades to
head, and checks the rows (and their annotations) survive the table rebuild
while the column nothing read is gone.
"""
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

from prepforge_chess.api import config as app_config

ROOT = Path(__file__).resolve().parents[1]
PREVIOUS = "b3e5c7d9f1a4"


@pytest.fixture()
def migrate(tmp_path, monkeypatch):
    db_file = tmp_path / "drop_meta.sqlite3"
    url = f"sqlite:///{db_file.as_posix()}"
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("PREPFORGE_SECRET_KEY", "test-secret-not-for-prod")
    monkeypatch.setenv("PREPFORGE_TOKEN_KEY", "test-token-key-not-for-prod")
    monkeypatch.setenv("PREPFORGE_ENV", "development")
    app_config.get_settings.cache_clear()
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    command.upgrade(cfg, PREVIOUS)
    engine = create_engine(url)
    yield engine, cfg
    engine.dispose()
    app_config.get_settings.cache_clear()


def test_upgrade_drops_the_unread_column_and_keeps_annotations(migrate):
    engine, cfg = migrate
    stamp = "'2026-01-01'"
    with engine.begin() as conn:
        conn.execute(text(
            f"INSERT INTO users (id, email, plan, created_at, updated_at) "
            f"VALUES ('u1', 'u1@x.test', 'free', {stamp}, {stamp})"
        ))
        conn.execute(text(
            "INSERT INTO games (id, source, initial_fen, result, uci_blob, tags_json, owner_user_id, created_at, updated_at) "
            f"VALUES ('g1', 'lichess', 'fen', '*', 'e2e4', '{{}}', 'u1', {stamp}, {stamp})"
        ))
        conn.execute(text(
            "INSERT INTO moves (game_id, ply, uci, classification, generated_comment, generated_meta_json, source) "
            "VALUES ('g1', 1, 'e2e4', 'best', 'A strong start.', :meta, 'lichess')"
        ), {"meta": '{"depth": 12}'})

    command.upgrade(cfg, "head")

    with engine.connect() as conn:
        columns = {row[1] for row in conn.execute(text("PRAGMA table_info(moves)"))}
        row = conn.execute(text(
            "SELECT ply, uci, classification, generated_comment FROM moves"
        )).mappings().one()
    assert "generated_meta_json" not in columns
    assert dict(row) == {
        "ply": 1, "uci": "e2e4", "classification": "best", "generated_comment": "A strong start.",
    }
