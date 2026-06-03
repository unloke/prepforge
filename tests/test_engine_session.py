import time

import chess
import pytest

from prepforge_chess.core.chess_core import STARTING_FEN
from prepforge_chess.services.stockfish_download import find_stockfish_executable
from prepforge_chess.web.server import EngineSession, PrepForgeWebApp


def _make_app(tmp_path):
    # The live engine session is a server-engine path, gated off by default in
    # the public flow; these tests exercise the admin/server-enabled behaviour.
    return PrepForgeWebApp(
        db_path=tmp_path / "engine.sqlite3",
        prefer_real_engines=True,
        server_engine_enabled=True,
    )


def test_engine_snapshot_empty_when_no_session(tmp_path):
    app = _make_app(tmp_path)
    snapshot = app.engine_session_snapshot_payload()
    assert snapshot["session_id"] is None
    assert snapshot["running"] is False
    assert snapshot["pvs"] == []


def test_engine_session_ignores_stale_worker_updates():
    session = EngineSession("session", "stockfish", "missing-stockfish")
    with session._lock:
        session._generation = 2
        session._state.update(
            {
                "fen": STARTING_FEN,
                "running": True,
                "current_depth": 0,
                "pvs": [],
            }
        )

    session._consume_loop(
        [{"depth": 12, "multipv": 1, "pv": []}],
        1,
        chess.Board(STARTING_FEN),
    )

    snapshot = session.snapshot()
    assert snapshot["running"] is True
    assert snapshot["current_depth"] == 0
    assert snapshot["pvs"] == []


def test_engine_session_opens_and_streams_pvs(tmp_path):
    if find_stockfish_executable() is None:
        pytest.skip("Stockfish executable is not installed.")

    app = _make_app(tmp_path)
    opened = app.engine_session_open_payload(fen=STARTING_FEN, multipv=2)
    try:
        assert opened["session_id"]
        # Max depth must come straight from the saved Stockfish depth setting.
        assert opened["max_depth"] == app.settings.get_stockfish_depth()

        # The floating widget owns only its engine session; it must not block
        # Analyze or Build through the global heavy-job slot.
        assert app.heavy_job_status()["active"] is False
        assert app.heavy_job_status()["kind"] is None

        deadline = time.time() + 8
        snapshot = opened
        while time.time() < deadline:
            snapshot = app.engine_session_snapshot_payload()
            if snapshot["pvs"] and snapshot["current_depth"] > 0:
                break
            time.sleep(0.1)

        assert snapshot["session_id"] == opened["session_id"]
        assert snapshot["current_depth"] > 0
        assert snapshot["pvs"], "expected at least one principal variation"
        top = snapshot["pvs"][0]
        assert top["pv_san"], "expected SAN moves for the top line"
    finally:
        app.engine_session_close_payload()

    # Closing the widget should leave the global heavy-job slot untouched.
    assert app.heavy_job_status()["active"] is False


def test_engine_session_keeps_global_heavy_job_slot_available(tmp_path):
    if find_stockfish_executable() is None:
        pytest.skip("Stockfish executable is not installed.")

    app = _make_app(tmp_path)
    app.engine_session_open_payload(fen=STARTING_FEN, multipv=1)
    try:
        status = app.heavy_job_status()
        assert status["active"] is False
        assert status["kind"] is None
        assert status["job_id"] is None
    finally:
        app.engine_session_close_payload()
