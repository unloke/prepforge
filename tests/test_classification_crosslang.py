"""Cross-language classification contract — both real implementations in one test.

The shared fixture pins each end to its own expectation column
(``expected.server`` / ``expected.browser``), but nothing asserted the two
columns stay mutually consistent — a threshold drift on one side could be
"fixed" by editing only that side's column while both suites stayed green.

This test closes the hole twice:

1. :func:`test_fixture_expectations_are_mutually_consistent` (no toolchain
   needed) asserts the fixture's two columns obey the documented taxonomy
   mapping — the server's ``excellent`` band (0 < loss <= 2) is labelled
   ``best`` by the browser coach; every other tier is 1:1.
2. :func:`test_browser_and_server_classifiers_agree` runs BOTH production
   implementations (``services/classification.py`` in-process, and
   ``web-src/coach/features.js`` under ``node``) over the same fixture cases
   and compares the outputs directly, so a threshold tweak on either end fails
   here even if someone edits the fixture to match.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from prepforge_chess.core.models import Color, EngineEvaluation, MoveClassification
from prepforge_chess.services.classification import classify_move

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = Path(__file__).parent / "fixtures" / "classification_golden.json"
GOLDEN = json.loads(FIXTURE.read_text(encoding="utf-8"))
CASES = GOLDEN["cases"]

# The two vocabularies differ by exactly one intentional mapping: the server
# splits BEST / EXCELLENT (best move vs <=2% loss), while the browser coach
# shows both bands as "Best move" and gates Brilliant candidacy on the same 2%
# edge. Everything else is 1:1; any new divergence must be added here
# deliberately, with a fixture note, instead of drifting silently.
SERVER_TO_BROWSER = {
    "best": "best",
    "excellent": "best",
    "good": "good",
    "inaccuracy": "inaccuracy",
    "mistake": "mistake",
    "blunder": "blunder",
}

_NODE_RUNNER = """
import { readFileSync } from "node:fs";
import { buildMoveFeatures } from %s;

const golden = JSON.parse(readFileSync(process.env.CLASSIFICATION_GOLDEN_PATH, "utf8"));
const out = golden.cases.map((testCase) => {
  const features = buildMoveFeatures({
    ply: 1,
    moveNumber: 1,
    mover: testCase.side_to_move,
    uci: testCase.played.uci,
    san: testCase.played.san,
    fenBefore: testCase.fen_before,
    fenAfter: testCase.fen_after,
    beforeEval: {
      lines: [
        {
          uci: testCase.best.uci,
          san: testCase.best.san,
          cp: testCase.best_eval_after.cp ?? null,
          mate: testCase.best_eval_after.mate ?? null,
          pvUci: [],
          pvSan: [],
        },
      ],
    },
    afterEval: {
      cp: testCase.played_eval_after.cp ?? null,
      mate: testCase.played_eval_after.mate ?? null,
      pvUci: [],
      pvSan: [],
    },
  });
  return {
    id: testCase.id,
    code: features.classification.code,
    brilliant_candidate: features.brilliantCandidate,
    win_delta: features.winDelta,
  };
});
process.stdout.write(JSON.stringify(out));
"""


def _server_result(case: dict):
    def _eval(spec: dict) -> EngineEvaluation:
        if spec.get("mate") is not None:
            return EngineEvaluation(engine="stockfish", mate_in=spec["mate"], score_cp=spec.get("cp"))
        return EngineEvaluation(engine="stockfish", score_cp=spec.get("cp"))

    return classify_move(
        side_to_move=Color(case["side_to_move"]),
        played_move_uci=case["played"]["uci"],
        best_move_uci=case["best"]["uci"],
        played_eval_after=_eval(case["played_eval_after"]),
        best_eval_after=_eval(case["best_eval_after"]),
    )


def test_fixture_expectations_are_mutually_consistent() -> None:
    """Both expectation columns must follow the declared mapping. This is the
    toolchain-free half of the contract: it keeps the fixture itself honest so
    editing one column without the other cannot pass both suites."""
    for case in CASES:
        expected = case["expected"]
        assert expected["browser"] == SERVER_TO_BROWSER[expected["server"]], (
            f"{case['id']}: fixture columns diverge beyond the documented "
            f"mapping (server={expected['server']}, browser={expected['browser']})"
        )


def test_browser_and_server_classifiers_agree() -> None:
    """Run both production classifiers over every fixture case and compare."""
    node = shutil.which("node")
    if node is None:  # pragma: no cover - node is a repo-wide dev dependency
        # Never skip: without one half of the contract there is no contract.
        # (Missing node_modules fails loudly too, via ERR_MODULE_NOT_FOUND.)
        pytest.fail(
            "node is required to run the browser classifier — install Node.js "
            "and run `npm ci`"
        )

    features_js = ROOT / "web-src" / "coach" / "features.js"
    assert features_js.exists()
    script = _NODE_RUNNER % json.dumps(features_js.as_uri())

    env = dict(os.environ)
    env["CLASSIFICATION_GOLDEN_PATH"] = str(FIXTURE)
    proc = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    assert proc.returncode == 0, f"node runner failed: {proc.stderr}"
    browser_results = {row["id"]: row for row in json.loads(proc.stdout)}
    assert set(browser_results) == {case["id"] for case in CASES}

    for case in CASES:
        server = _server_result(case)
        browser = browser_results[case["id"]]
        assert browser["code"] == SERVER_TO_BROWSER[server.classification.value], (
            f"{case['id']}: implementations disagree — server "
            f"{server.classification.value} vs browser {browser['code']}"
        )
        server_eligible = server.classification in {
            MoveClassification.BEST,
            MoveClassification.EXCELLENT,
        }
        assert browser["brilliant_candidate"] == server_eligible, (
            f"{case['id']}: brilliant-candidate eligibility disagrees"
        )
