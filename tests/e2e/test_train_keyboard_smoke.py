"""Playwright E2E smoke for keyboard play on the Train board.

Starts a local uvicorn on a throwaway SQLite DB (same harness as the Scout
smokes), seeds a one-move repertoire over the API, and plays the Smart Train
prompt entirely from the keyboard: Enter selects the piece (the square button
exposes aria-pressed), Enter on the target plays it, and the graded banner
flips to the correct state. Skipped when Playwright/Chromium is unavailable.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from e2e_harness import run_e2e_script

ROOT = Path(__file__).resolve().parents[2]
TRAIN_KEYBOARD_SCRIPT = ROOT / "tests" / "e2e" / "train_keyboard_smoke.mjs"


@pytest.mark.e2e
def test_train_keyboard_smoke(tmp_path, monkeypatch):
    run_e2e_script(TRAIN_KEYBOARD_SCRIPT, tmp_path)
