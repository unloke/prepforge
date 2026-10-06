"""Cross-end Brilliant/Great sanity gates — the server half.

``tests/fixtures/sanity_gates_golden.json`` is shared with the browser suite
(``web-src/coach/sanity-gates-golden.test.js``): ``sanity_exclusion`` in
services/brilliant.py and ``sanityExclusion`` in web-src/coach/features.js must
exclude exactly the same moves.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from prepforge_chess.services.brilliant import sanity_exclusion

FIXTURE = Path(__file__).parent / "fixtures" / "sanity_gates_golden.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_server_sanity_exclusion_matches_golden(case: dict) -> None:
    assert (
        sanity_exclusion(
            case["fen_before"],
            case["uci"],
            case["previous_fen_before"],
            case["previous_uci"],
        )
        == case["expected"]
    )
