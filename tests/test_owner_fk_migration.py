"""Forward migration e7a1c3d5f9b2: owner foreign keys on SQLite.

Builds a database at the previous revision with real child rows, upgrades to head,
and checks that the existing rows survive and that deleting a user cascades.
"""
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

from prepforge_chess.api import config as app_config

ROOT = Path(__file__).resolve().parents[1]
PREVIOUS = "d4e6f8a0b2c3"
HEAD = "e7a1c3d5f9b2"


@pytest.fixture()
def migrate(tmp_path, monkeypatch):
    db_file = tmp_path / "owner_fk.sqlite3"
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


def _seed(conn):
    stamp = "'2026-01-01'"
    for uid in ("u1", "u2"):
        conn.execute(text(
            f"INSERT INTO users (id, email, plan, created_at, updated_at) "
            f"VALUES ('{uid}', '{uid}@x.test', 'free', {stamp}, {stamp})"
        ))
    conn.execute(text(
        "INSERT INTO games (id, source, initial_fen, result, uci_blob, tags_json, owner_user_id, created_at, updated_at) "
        f"VALUES ('g1', 'lichess', 'fen', '*', '', '{{}}', 'u1', {stamp}, {stamp})"
    ))
    conn.execute(text(
        "INSERT INTO moves (game_id, ply, uci, classification, source) VALUES ('g1', 1, 'e2e4', 'book', 'lichess')"
    ))
    conn.execute(text(
        "INSERT INTO repertoires (id, owner_user_id, name, color, root_fen, tags_json, is_active, created_at, updated_at) "
        f"VALUES ('r1', 'u1', 'Mine', 'white', 'fen', '[]', 1, {stamp}, {stamp})"
    ))
    conn.execute(text(
        f"INSERT INTO user_settings (user_id, key, value_json, updated_at) VALUES ('u1', 'k', 'null', {stamp})"
    ))


def _count(conn, table):
    return conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar()


def test_upgrade_keeps_rows_and_adds_owner_fks(migrate):
    engine, cfg = migrate
    with engine.begin() as conn:
        _seed(conn)
    tables = ("games", "moves", "repertoires", "user_settings")
    with engine.connect() as conn:
        before = {t: _count(conn, t) for t in tables}

    command.upgrade(cfg, HEAD)

    with engine.connect() as conn:
        after = {t: _count(conn, t) for t in tables}
        # Child rows of games (moves) must not be cascaded away by the table rebuild.
        assert after == before
        fks = {
            table: {(row[2], row[3], row[6]) for row in conn.execute(text(f"PRAGMA foreign_key_list({table})"))}
            for table in ("games", "repertoires", "training_progress", "user_settings")
        }
    assert ("users", "owner_user_id", "CASCADE") in fks["games"]
    assert ("users", "owner_user_id", "CASCADE") in fks["repertoires"]
    assert ("users", "owner_user_id", "CASCADE") in fks["training_progress"]
    assert ("users", "user_id", "CASCADE") in fks["user_settings"]


def test_deleting_user_cascades_owner_rows(migrate):
    engine, cfg = migrate
    with engine.begin() as conn:
        _seed(conn)
    command.upgrade(cfg, HEAD)
    with engine.begin() as conn:
        conn.execute(text("PRAGMA foreign_keys=ON"))
        conn.execute(text("DELETE FROM users WHERE id = 'u1'"))
    with engine.connect() as conn:
        assert _count(conn, "games") == 0
        assert _count(conn, "moves") == 0  # moves cascade from games
        assert _count(conn, "repertoires") == 0
        assert _count(conn, "user_settings") == 0
        assert _count(conn, "users") == 1  # u2 untouched


def test_upgrade_refuses_orphan_owner_rows(migrate):
    engine, cfg = migrate
    with engine.begin() as conn:
        _seed(conn)
        conn.execute(text(
            "INSERT INTO games (id, source, initial_fen, result, uci_blob, tags_json, owner_user_id, created_at, updated_at) "
            "VALUES ('ghost', 'lichess', 'fen', '*', '', '{}', 'nobody', '2026-01-01', '2026-01-01')"
        ))
    with pytest.raises(Exception, match="missing users"):
        command.upgrade(cfg, HEAD)
    with engine.connect() as conn:
        assert _count(conn, "games") == 2  # nothing was rebuilt or deleted


def test_downgrade_then_upgrade_round_trips(migrate):
    engine, cfg = migrate
    with engine.begin() as conn:
        _seed(conn)
    command.upgrade(cfg, HEAD)
    command.downgrade(cfg, PREVIOUS)
    with engine.connect() as conn:
        assert _count(conn, "games") == 1
        assert not any(row[2] == "users" for row in conn.execute(text("PRAGMA foreign_key_list(games)")))
    command.upgrade(cfg, HEAD)
    with engine.connect() as conn:
        assert _count(conn, "games") == 1
