"""Browser regression: finishing a Smart Train session with the Repertoire tree open.

The finish used to refresh the open repertoire's tree by handing ``hydrateBuild``
the repertoire's ID where it expects the ``/api/build/load`` payload, so
``appState.build`` became a string and the next paint reported
"Cannot read properties of undefined (reading 'filter')" the moment training
finished. The script plays a real seeded queue to completion with a tree open and
fails on any page error or unhandled rejection.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from e2e_harness import run_e2e_script

ROOT = Path(__file__).resolve().parents[2]
TRAIN_COMPLETION_SCRIPT = ROOT / "tests" / "e2e" / "train_completion_smoke.mjs"


@pytest.mark.e2e
def test_train_completion_smoke(tmp_path, monkeypatch):
    run_e2e_script(TRAIN_COMPLETION_SCRIPT, tmp_path)
