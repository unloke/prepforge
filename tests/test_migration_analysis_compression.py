"""b3e5c7d9f1a4 rewrites stored analysis snapshots; the runtime reads only the new form."""
import importlib.util
import json
from dataclasses import asdict
from pathlib import Path

import sqlalchemy as sa

from prepforge_chess.core.chess_core import STARTING_FEN
from prepforge_chess.storage import codec


def _load_migration():
    path = Path("migrations/versions/b3e5c7d9f1a4_compact_analysis_snapshots.py")
    spec = importlib.util.spec_from_file_location("compact_snapshot_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_snapshot_migration_rewrites_into_the_compact_codec(monkeypatch):
    migration = _load_migration()
    moves = codec.rebuild_moves(STARTING_FEN, ["e2e4", "e7e5"])
    legacy = migration._legacy_payload(moves)
    assert json.loads(legacy)["codec"] == "zlib-base64-v1"

    engine = sa.create_engine("sqlite://")
    table = sa.Table(
        "analysis_results",
        sa.MetaData(),
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("move_results_json", sa.Text),
    )
    table.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(
            table.insert(),
            [{"id": str(i).zfill(3), "move_results_json": legacy} for i in range(105)]
            + [{"id": "missing", "move_results_json": None}],
        )
        monkeypatch.setattr(migration.op, "get_bind", lambda: connection)
        migration.upgrade()
        for payload in connection.execute(sa.select(table.c.move_results_json)).scalars():
            if payload is not None:
                # One conversion pass: the compact form is smaller and round-trips.
                assert json.loads(payload)["codec"] == codec.ANALYSIS_SNAPSHOT_CODEC
                assert len(payload) < len(legacy)
                assert codec.decode_analysis_moves(payload) == moves
        migration.downgrade()
        restored = connection.execute(
            sa.select(table.c.move_results_json).where(table.c.id == "001")
        ).scalar_one()
        assert json.loads(restored)["codec"] == "zlib-base64-v1"
        assert migration._legacy_moves(restored) == moves
        assert connection.execute(
            sa.select(table.c.move_results_json).where(table.c.id == "missing")
        ).scalar_one() is None
    engine.dispose()


def test_compact_snapshot_is_about_half_the_legacy_payload():
    """The per-ply object dump repeated FENs, SAN and three copies of each eval."""
    import zlib
    import base64

    moves = codec.rebuild_moves(STARTING_FEN, ["g1f3", "g8f6", "f3g1", "f6g8"] * 15)
    for move in moves:
        move.engine_eval_before = codec.EngineEvaluation(engine="sf", depth=12, score_cp=20, pv=["e2e4"])
        move.engine_eval_after = codec.EngineEvaluation(engine="sf", depth=12, score_cp=18, pv=["e7e5"])
        move.best_move_eval = move.engine_eval_before
    legacy = json.dumps([asdict(move) for move in moves], separators=(",", ":")).encode("utf-8")
    legacy_size = len(json.dumps(
        {"codec": "zlib-base64-v1", "data": base64.b64encode(zlib.compress(legacy)).decode("ascii")},
        separators=(",", ":"),
    ))
    compact = codec.encode_analysis_moves(moves)
    assert len(compact) < legacy_size / 2, (len(compact), legacy_size)
    assert codec.decode_analysis_moves(compact) == moves
