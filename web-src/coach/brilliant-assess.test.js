import { describe, it, expect } from "vitest";

import { computeBrilliantAssessments, attachClientTrapGaps } from "./brilliant-assess.js";
import { moverWinChanceAfter } from "./features.js";
import { localBoardAfterMove } from "../chess-local.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = localBoardAfterMove(START_FEN, "e2e4").move.fen_after; // the "played" position
const AFTER_D4 = localBoardAfterMove(START_FEN, "d2d4").move.fen_after; // the "natural" position

// A fake Stockfish batch: returns the requested cp for each position it is asked about
// (keyed by FEN, exactly as analyzeGamePositions does), so the eval-map lookup path is real.
function fakeAnalyzeFn(cpByFen) {
  return async ({ positions }) =>
    new Map(positions.filter((p) => p in cpByFen).map((p) => [p, { score_cp: cpByFen[p], mate_in: null }]));
}

// A fake Maia provider. `naturalUci` is what predictions() returns (the move a human would
// play); `assessment` is what moveAssessment() returns for every move.
function fakeProvider({ naturalUci = "d2d4", assessment = { humanProbability: 0.02, winChanceAfter: 0.3 } } = {}) {
  return {
    moveAssessment: async () => assessment,
    predictions: async () => (naturalUci === null ? [] : [{ move_uci: naturalUci }]),
  };
}

const cancelledError = () => {
  const err = new Error("Analysis stopped");
  err.cancelled = true;
  return err;
};

function brilliantCandidate(overrides = {}) {
  return {
    item: { fen: START_FEN, uci: "e2e4" },
    side: "white",
    playedAfterFen: AFTER_E4,
    ...overrides,
  };
}

describe("attachClientTrapGaps", () => {
  it("computes trap_gap from the provider policy + the eval-map shapes (the value the server replays)", async () => {
    const cand = brilliantCandidate();
    await attachClientTrapGaps({
      candidates: [cand],
      evals: new Map([[AFTER_E4, { score_cp: 200, mate_in: null }]]),
      depth: 12,
      rating: 1500,
      provider: fakeProvider({ naturalUci: "d2d4" }),
      analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
      shouldCancel: () => false,
      cancelledError,
    });
    // played (cp +200) holds the advantage the natural d4 (cp -100) throws away → positive gap,
    // and it equals exactly sf_truth(played) − sf_truth(natural) on the server's win-chance scale.
    const expected =
      moverWinChanceAfter({ cp: 200, mate: null }, "white") - moverWinChanceAfter({ cp: -100, mate: null }, "white");
    expect(cand.item.trap_gap).toBeCloseTo(expected, 10);
    expect(cand.item.trap_gap).toBeGreaterThan(0);
  });

  it("ships a real 0 when the natural move IS the played move (no trap)", async () => {
    const cand = brilliantCandidate();
    await attachClientTrapGaps({
      candidates: [cand],
      evals: new Map([[AFTER_E4, { score_cp: 200, mate_in: null }]]),
      depth: 12,
      rating: 1500,
      provider: fakeProvider({ naturalUci: "e2e4" }), // human would play the same move
      analyzeFn: fakeAnalyzeFn({}),
      shouldCancel: () => false,
      cancelledError,
    });
    expect(cand.item.trap_gap).toBe(0);
  });

  it("leaves trap_gap ABSENT when the natural move's eval is missing (fail closed)", async () => {
    const cand = brilliantCandidate();
    await attachClientTrapGaps({
      candidates: [cand],
      evals: new Map([[AFTER_E4, { score_cp: 200, mate_in: null }]]),
      depth: 12,
      rating: 1500,
      provider: fakeProvider({ naturalUci: "d2d4" }),
      analyzeFn: fakeAnalyzeFn({}), // engine returns nothing for the natural position
      shouldCancel: () => false,
      cancelledError,
    });
    expect("trap_gap" in cand.item).toBe(false);
  });

  it("leaves trap_gap ABSENT when Maia has no policy (un-evaluable)", async () => {
    const cand = brilliantCandidate();
    await attachClientTrapGaps({
      candidates: [cand],
      evals: new Map([[AFTER_E4, { score_cp: 200, mate_in: null }]]),
      depth: 12,
      rating: 1500,
      provider: fakeProvider({ naturalUci: null }), // predictions() → []
      analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
      shouldCancel: () => false,
      cancelledError,
    });
    expect("trap_gap" in cand.item).toBe(false);
  });

  it("leaves trap_gap ABSENT when the played position's eval is missing", async () => {
    const cand = brilliantCandidate();
    await attachClientTrapGaps({
      candidates: [cand],
      evals: new Map(), // no eval for the played fen_after
      depth: 12,
      rating: 1500,
      provider: fakeProvider({ naturalUci: "d2d4" }),
      analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
      shouldCancel: () => false,
      cancelledError,
    });
    expect("trap_gap" in cand.item).toBe(false);
  });

  it("aborts the second pass when cancellation arrives", async () => {
    const cand = brilliantCandidate();
    await expect(
      attachClientTrapGaps({
        candidates: [cand],
        evals: new Map([[AFTER_E4, { score_cp: 200, mate_in: null }]]),
        depth: 12,
        rating: 1500,
        provider: fakeProvider({ naturalUci: "d2d4" }),
        analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
        shouldCancel: () => true, // Stop pressed
        cancelledError,
      }),
    ).rejects.toMatchObject({ cancelled: true });
    expect("trap_gap" in cand.item).toBe(false);
  });
});

describe("computeBrilliantAssessments (first + second pass together)", () => {
  const moves = [{ fen_before: START_FEN, uci: "e2e4", fen_after: AFTER_E4, side: "white" }];

  it("assesses each move and attaches a trap_gap to the unintuitive candidate", async () => {
    const progress = [];
    const out = await computeBrilliantAssessments({
      moves,
      evals: new Map([[AFTER_E4, { score_cp: 200, mate_in: null }]]),
      depth: 12,
      rating: 1500,
      provider: fakeProvider({ naturalUci: "d2d4", assessment: { humanProbability: 0.02, winChanceAfter: 0.3 } }),
      analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
      onProgress: (done, total) => progress.push([done, total]),
      shouldCancel: () => false,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fen: START_FEN, uci: "e2e4", human_probability: 0.02 });
    expect(out[0].trap_gap).toBeGreaterThan(0);
    expect(progress).toEqual([[1, 1]]);
  });

  it("does NOT attach a trap_gap to an intuitive move (never a candidate, so no extra engine work)", async () => {
    const out = await computeBrilliantAssessments({
      moves,
      evals: new Map([[AFTER_E4, { score_cp: 200, mate_in: null }]]),
      depth: 12,
      rating: 1500,
      // humanProbability 0.5 is well over the cap → not unintuitive → not a candidate
      provider: fakeProvider({ naturalUci: "d2d4", assessment: { humanProbability: 0.5, winChanceAfter: 0.55 } }),
      analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
      shouldCancel: () => false,
    });
    expect(out).toHaveLength(1);
    expect("trap_gap" in out[0]).toBe(false);
  });

  it("skips a move whose assessment is non-finite (Maia inference failed)", async () => {
    const out = await computeBrilliantAssessments({
      moves,
      evals: new Map([[AFTER_E4, { score_cp: 200, mate_in: null }]]),
      depth: 12,
      rating: 1500,
      provider: fakeProvider({ naturalUci: "d2d4", assessment: { humanProbability: NaN, winChanceAfter: 0.3 } }),
      analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
      shouldCancel: () => false,
    });
    expect(out).toHaveLength(0);
  });

  it("stops before any assessment when cancellation is already set", async () => {
    await expect(
      computeBrilliantAssessments({
        moves,
        evals: new Map([[AFTER_E4, { score_cp: 200, mate_in: null }]]),
        depth: 12,
        rating: 1500,
        provider: fakeProvider(),
        analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
        shouldCancel: () => true,
      }),
    ).rejects.toMatchObject({ cancelled: true });
  });
});
