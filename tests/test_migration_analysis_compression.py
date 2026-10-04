"""Current snapshot migration converts persisted payloads without a runtime fallback."""
import importlib.util
import json
from dataclasses import asdict
from pathlib import Path

import sqlalchemy as sa

from prepforge_chess.core.chess_core import STARTING_FEN
from prepforge_chess.storage import codec


def test_snapshot_compression_migration_round_trip(monkeypatch):
    path = Path("migrations/versions/f7a9b1c3d5e7_compress_analysis_snapshots.py")
    spec = importlib.util.spec_from_file_location("snapshot_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    moves = codec.rebuild_moves(STARTING_FEN, ["e2e4", "e7e5"])
    raw = json.dumps([asdict(move) for move in moves])
    engine = sa.create_engine("sqlite://")
    table = sa.Table("analysis_results", sa.MetaData(), sa.Column("id", sa.Text, primary_key=True), sa.Column("move_results_json", sa.Text))
    table.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(table.insert(), [{"id": str(i).zfill(3), "move_results_json": raw} for i in range(105)] + [{"id":"missing", "move_results_json":None}])
        monkeypatch.setattr(migration.op, "get_bind", lambda: connection)
        migration.upgrade()
        for payload in connection.execute(sa.select(table.c.move_results_json)).scalars():
            if payload is not None:
                assert codec.decode_analysis_moves(payload) == moves
        migration.downgrade()
        assert connection.execute(sa.select(table.c.move_results_json).where(table.c.id=="001")).scalar_one() == raw
        assert connection.execute(sa.select(table.c.move_results_json).where(table.c.id=="missing")).scalar_one() is None
    engine.dispose()
