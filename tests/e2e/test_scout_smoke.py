"""Playwright E2E smoke for Scout.

Starts a local uvicorn on a throwaway SQLite DB, registers a user via the
browser, and verifies the Scout report and Analyze hand-off. The Node smoke
uses a deterministic, browser-local PGN upstream fixture by default; set
``E2E_SCOUT_UPSTREAM=live`` for an opt-in live Lichess check.

Refutation smoke needs an E2E build first::

    npm run build:e2e

That sets ``VITE_ENABLE_SCOUT_E2E=1`` at compile time; the browser must also
open ``?scout_e2e=1`` as a second opt-in layer.

Skipped when Playwright/Chromium is unavailable (same pattern as lazy-chunk smoke).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from e2e_harness import run_e2e_script

ROOT = Path(__file__).resolve().parents[2]
SCOUT_SCRIPT = ROOT / "tests" / "e2e" / "scout_smoke.mjs"
SCOUT_REFUTATION_SCRIPT = ROOT / "tests" / "e2e" / "scout_refutation_smoke.mjs"


@pytest.mark.e2e
def test_scout_smoke(tmp_path, monkeypatch):
    run_e2e_script(SCOUT_SCRIPT, tmp_path)


@pytest.mark.e2e
def test_scout_refutation_smoke(tmp_path, monkeypatch):
    run_e2e_script(SCOUT_REFUTATION_SCRIPT, tmp_path)
