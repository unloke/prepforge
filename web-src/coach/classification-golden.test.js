// Cross-end classification contract — the browser half.
//
// tests/fixtures/classification_golden.json is shared with the server suite
// (tests/test_classification_golden.py). The two production implementations
// stay independent — services/classification.py ↔ web-src/coach/features.js —
// and this contract pins both to the same golden semantics: tier behaviour at
// the 0/2/5/10/15 win-chance-loss boundaries, mate and extreme evaluations, and
// the Brilliant-candidate 2% eligibility edge (BRILLIANT_MAX_CANDIDATE_WIN_DELTA).
// Cases run through the REAL feature pipeline (buildMoveFeatures), which is
// what the coach UI consumes, so the contract covers conversion + bucketing.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BRILLIANT_MAX_CANDIDATE_WIN_DELTA,
  buildMoveFeatures,
  classifyMoveRich,
} from "./features.js";

const GOLDEN = JSON.parse(
  readFileSync(
    new URL("../../tests/fixtures/classification_golden.json", import.meta.url),
    "utf8",
  ),
);

function featuresFor(testCase) {
  return buildMoveFeatures({
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
}

describe("classification golden contract (browser side)", () => {
  for (const testCase of GOLDEN.cases) {
    it(`${testCase.id}: ${testCase.description}`, () => {
      const features = featuresFor(testCase);
      expect(features.classification.code).toBe(testCase.expected.browser);
      expect(features.brilliantCandidate).toBe(testCase.expected.brilliant_candidate);
      if (testCase.expected.loss_pct !== null) {
        // Shared numeric contract: the same evals must yield the same mover-POV
        // win-chance loss on both ends (within rounding of the fixture value).
        expect(features.winDelta).toBeCloseTo(testCase.expected.loss_pct, 1);
      }
    });
  }

  it("brilliant eligibility cap matches the fixture and the server's excellent_loss", () => {
    // features.js gates Brilliant candidates at <= 2 win% points ⇔ the server's
    // ClassificationConfig.excellent_loss = 0.02 (see the fixture notes).
    expect(BRILLIANT_MAX_CANDIDATE_WIN_DELTA).toBe(
      GOLDEN.brilliant_candidate_max_win_delta_pct,
    );
    expect(BRILLIANT_MAX_CANDIDATE_WIN_DELTA).toBe(
      GOLDEN.thresholds_pct.excellent_max_loss,
    );
  });

  it("classifyMoveRich honours each fixture boundary directly", () => {
    // Belt-and-suspenders: the pure grader sees the same tiers at the shared
    // loss values, independent of the eval→win% conversion.
    const tiers = [
      [0, "best"],
      [GOLDEN.thresholds_pct.excellent_max_loss, "best"],
      [GOLDEN.thresholds_pct.good_max_loss, "good"],
      [GOLDEN.thresholds_pct.inaccuracy_max_loss, "inaccuracy"],
      [GOLDEN.thresholds_pct.mistake_max_loss, "mistake"],
      [GOLDEN.thresholds_pct.mistake_max_loss + 1, "blunder"],
    ];
    for (const [winDelta, code] of tiers) {
      expect(
        classifyMoveRich({
          winDelta,
          winAfterMover: 50,
          isBest: false,
          onlyMove: false,
          forced: false,
        }).code,
      ).toBe(code);
    }
  });

  it("fixture covers a case on each side of every boundary", () => {
    const losses = GOLDEN.cases
      .map((testCase) => testCase.expected.loss_pct)
      .filter((loss) => loss !== null);
    for (const boundary of [2, 5, 10, 15]) {
      expect(losses.some((loss) => loss < boundary)).toBe(true);
      expect(losses.some((loss) => loss > boundary)).toBe(true);
    }
    expect(losses).toContain(0);
  });
});
