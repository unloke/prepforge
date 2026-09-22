"""Reproducible axe-core accessibility baseline (serious/critical gate).

Runs ``tests/e2e/axe_baseline.mjs`` against a throwaway uvicorn + SQLite DB,
following the same pattern as ``test_scout_smoke.py`` (register via browser,
scan representative screens). The node script prints JSON and exits nonzero
on any serious/critical first-party violation.

Fixed first-party contrast issues stay fixed via the vitest token-contrast
guard in ``web-src/visual-system.test.js``; this E2E is the full-page
verification (real computed styles, all views + palette + modal).

Skipped when Playwright/Chromium or @axe-core/playwright is unavailable.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from e2e_harness import run_e2e_script

ROOT_AXE = Path(__file__).resolve().parents[2]
AXE_SCRIPT = ROOT_AXE / "tests" / "e2e" / "axe_baseline.mjs"


@pytest.mark.e2e
def test_axe_baseline(tmp_path, monkeypatch):
    run_e2e_script(AXE_SCRIPT, tmp_path)
