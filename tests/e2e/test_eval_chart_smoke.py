"""Playwright E2E smoke for the Analyze eval chart.

Starts a local uvicorn on a throwaway SQLite DB (same harness as the Scout and
Train smokes) and drives the chart through mouse hover/click, keyboard
stepping + Enter, the dark-theme token wiring, and the current-ply indicator.
Requires an E2E build of the SPA (``npm run build:e2e`` — the ?analyze_e2e=1
hook is compiled behind VITE_ENABLE_SCOUT_E2E). Skipped when
Playwright/Chromium is unavailable.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from e2e_harness import run_e2e_script

ROOT = Path(__file__).resolve().parents[2]
EVAL_CHART_SCRIPT = ROOT / "tests" / "e2e" / "eval_chart_smoke.mjs"


@pytest.mark.e2e
def test_eval_chart_smoke(tmp_path, monkeypatch):
    run_e2e_script(EVAL_CHART_SCRIPT, tmp_path)
