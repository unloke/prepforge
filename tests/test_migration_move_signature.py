import os
import uuid

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from prepforge_chess.api.config import get_settings
from prepforge_chess.storage import codec

_BEFORE = "c4e6a8b0d2f3"
_STAMP = "2026-01-01 00:00:00"
_CUSTOM = "8/8/8/8/8/8/4K3/4k3 w - - 0 1"


@pytest.fixture(params=["sqlite", "postgres"])
def migrated(request, tmp_path, monkeypatch):
    admin = None
    schema = None
    if request.param == "postgres":
        raw = os.getenv("TEST_POSTGRES_URL")
        if not raw:
            pytest.skip("TEST_POSTGRES_URL requires real PostgreSQL")
        url = raw.replace("postgresql://", "postgresql+psycopg://", 1)
        schema = "signature_" + uuid.uuid4().hex[:16]
        admin = sa.create_engine(url, isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
        monkeypatch.setenv("PGOPTIONS", "-c search_path=" + schema)
    else:
        url = "sqlite:///" + str(tmp_path / "signature.sqlite3")
    monkeypatch.setenv("DATABASE_URL", url)
    get_settings.cache_clear()
    cfg = Config("alembic.ini")
    engine = sa.create_engine(url)
    try:
        command.upgrade(cfg, _BEFORE)
        yield cfg, engine
    finally:
        engine.dispose()
        get_settings.cache_clear()
        if admin:
            with admin.connect() as conn:
                conn.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')


def _insert_game(conn, game_id, fen, blob):
    conn.execute(sa.text(
        "INSERT INTO games (id, source, initial_fen, uci_blob, result, tags_json, owner_user_id, created_at, updated_at)"
        " VALUES (:id, 'manual', :fen, :blob, '*', '{}', 'u1', :stamp, :stamp)"
    ), {"id": game_id, "fen": fen, "blob": blob, "stamp": _STAMP})


def test_upgrade_backfills_signatures_and_downgrade_drops_them(migrated):
    cfg, engine = migrated
    with engine.begin() as conn:
        conn.execute(sa.text(
            "INSERT INTO users (id, email, plan, created_at, updated_at)"
            " VALUES ('u1', 'u1@x.test', 'free', :stamp, :stamp)"
        ), {"stamp": _STAMP})
        _insert_game(conn, "g-start", codec.STARTING_FEN, "e2e4 e7e5")
        _insert_game(conn, "g-custom", _CUSTOM, "e2d2")
        _insert_game(conn, "g-bad-fen", "not a fen", "e2e4")
        _insert_game(conn, "g-empty", codec.STARTING_FEN, "")
        conn.execute(sa.text(
            "INSERT INTO moves (game_id, ply, classification, source)"
            " VALUES ('g-start', 1, 'book', 'manual')"
        ))

    command.upgrade(cfg, "head")
    with engine.connect() as conn:
        stored = dict(conn.execute(sa.text("SELECT id, move_signature FROM games")).all())
        moves = conn.execute(sa.text("SELECT count(*) FROM moves")).scalar_one()
    assert moves == 1  # the table rebuild keeps child rows
    assert bytes(stored["g-start"]) == codec.move_signature_digest(
        codec.move_signature(None, ["e2e4", "e7e5"])
    )
    assert bytes(stored["g-custom"]) == codec.move_signature_digest(codec.move_signature(_CUSTOM, ["e2d2"]))
    assert bytes(stored["g-bad-fen"]) == codec.stored_move_signature("not a fen", "e2e4")
    assert bytes(stored["g-empty"]) == codec.stored_move_signature(codec.STARTING_FEN, "")
    indexes = {index["name"] for index in sa.inspect(engine).get_indexes("games")}
    assert "idx_games_owner_signature" in indexes

    command.downgrade(cfg, _BEFORE)
    columns = {column["name"] for column in sa.inspect(engine).get_columns("games")}
    assert "move_signature" not in columns
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT count(*) FROM games")).scalar_one() == 4
        assert conn.execute(sa.text("SELECT count(*) FROM moves")).scalar_one() == 1


def test_signature_from_migration_matches_import_dedupe(migrated):
    cfg, engine = migrated
    with engine.begin() as conn:
        conn.execute(sa.text(
            "INSERT INTO users (id, email, plan, created_at, updated_at)"
            " VALUES ('u1', 'u1@x.test', 'free', :stamp, :stamp)"
        ), {"stamp": _STAMP})
        _insert_game(conn, "g-old", codec.STARTING_FEN, "e2e4 e7e5 g1f3")
    command.upgrade(cfg, "head")

    from prepforge_chess.services.pgn_import import PgnImportService
    from prepforge_chess.storage.repositories.workspace import WorkspaceRepository

    service = PgnImportService(WorkspaceRepository(engine))
    again = service.import_text('[Result "*"]\n\n1. e4 e5 2. Nf3 *', owner_user_id="u1")
    assert again.imported_count == 0
    assert again.skipped_game_ids == ["g-old"]
