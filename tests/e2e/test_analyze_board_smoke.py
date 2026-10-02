"""Playwright E2E smoke for the Analyze board and engine-line preview.

Starts a local uvicorn on a throwaway SQLite DB (same harness as the other smokes)
and checks that the board never keeps a focus ring after a click (arrow keys step the
game), and that clicking an engine line plays it on the board, steps through it and
returns to the game without changing it. Requires an E2E build of the SPA
(``npm run build:e2e``). Skipped when Playwright/Chromium is unavailable.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from e2e_harness import run_e2e_script

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tests" / "e2e" / "analyze_board_smoke.mjs"


@pytest.mark.e2e
def test_analyze_board_smoke(tmp_path, monkeypatch):
    run_e2e_script(SCRIPT, tmp_path)
