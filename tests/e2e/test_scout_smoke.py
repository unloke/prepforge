"""Playwright E2E smoke for Scout (Replay tab card).

Starts a local uvicorn on a throwaway SQLite DB, registers a user via the
browser, scouts a public Lichess player, and verifies Analyze hand-off.

Skipped when Playwright/Chromium is unavailable (same pattern as lazy-chunk smoke).
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCOUT_SCRIPT = ROOT / "tests" / "e2e" / "scout_smoke.mjs"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.e2e
def test_scout_smoke(tmp_path, monkeypatch):
    if not SCOUT_SCRIPT.is_file():
        pytest.skip("scout_smoke.mjs missing")

    port = _free_port()
    db_file = tmp_path / "scout_e2e.sqlite3"
    env = os.environ.copy()
    env.update(
        {
            "DATABASE_URL": f"sqlite:///{db_file.as_posix()}",
            "PREPFORGE_SECRET_KEY": "e2e-scout-secret-not-for-prod",
            "PREPFORGE_ENV": "development",
            "E2E_BASE_URL": f"http://127.0.0.1:{port}",
        }
    )

    migrate = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if migrate.returncode != 0:
        pytest.fail(f"alembic upgrade failed:\n{migrate.stderr or migrate.stdout}")

    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "prepforge_chess.api.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.time() + 45
        ok = False
        while time.time() < deadline:
            try:
                import urllib.request

                with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as r:
                    if r.status == 200:
                        ok = True
                        break
            except OSError:
                pass
            time.sleep(0.3)
        if not ok:
            err = proc.stderr.read() if proc.stderr else ""
            pytest.fail(f"uvicorn did not become ready on :{port}\n{err}")

        result = subprocess.run(
            ["node", str(SCOUT_SCRIPT)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        if result.returncode != 0:
            combined = (result.stdout or "") + (result.stderr or "")
            if "playwright not installed" in combined or "no Chromium" in combined:
                pytest.skip(combined.strip())
            pytest.fail(combined.strip() or f"scout smoke exited {result.returncode}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()