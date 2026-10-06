import { describe, it, expect } from "vitest";

import { computeBrilliantAssessments, createBrilliantAssessor, attachClientTrapGaps, attachAlternativeGaps } from "./brilliant-assess.js";
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

// fakeAnalyzeFn plus the deep MultiPV-3 confirmation read of `fen`: `lines` are
// [uci, cp] pairs, best first.
function confirmingAnalyzeFn(cpByFen, fen, lines) {
  const single = fakeAnalyzeFn(cpByFen);
  return async (o) => {
    if (o.multipv !== 3) return single(o);
    const [[best, cp], second, third] = lines;
    const line = (l) => (l ? { move_uci: l[0], score_cp: l[1], mate_in: null } : null);
    return new Map([[fen, { score_cp: cp, mate_in: null, best_move_uci: best, second: line(second), third: line(third) }]]);
  };
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
  it("reuses a natural-move evaluation from the main pass without another search", async () => {
    const cand = brilliantCandidate();
    await attachClientTrapGaps({
      candidates: [cand],
      evals: new Map([
        [AFTER_E4, { score_cp: 200, mate_in: null }],
        [AFTER_D4, { score_cp: -100, mate_in: null }],
      ]),
      depth: 16,
      rating: 1500,
      provider: fakeProvider(),
      analyzeFn: async () => { throw new Error("Redundant search"); },
      shouldCancel: () => false,
      cancelledError,
    });
    const expected = moverWinChanceAfter({ cp: 200, mate: null }, "white") -
      moverWinChanceAfter({ cp: -100, mate: null }, "white");
    expect(cand.item.trap_gap).toBeCloseTo(expected, 10);
  });

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

  // Eligible (winDelta 0: both before/after cp 200) so the move is assessed, AND the reveal
  // gap clears (engineWin ≈ 67.6 vs Maia 30).
  const ELIGIBLE_REVEALING_EVALS = new Map([
    [START_FEN, { score_cp: 200, mate_in: null }],
    [AFTER_E4, { score_cp: 200, mate_in: null }],
  ]);

  it("assesses each move and attaches a trap_gap to a candidate that clears every cheaper layer", async () => {
    const progress = [];
    const out = await computeBrilliantAssessments({
      moves,
      evals: ELIGIBLE_REVEALING_EVALS,
      depth: 12,
      rating: 1500,
      provider: fakeProvider({ naturalUci: "d2d4", assessment: { humanProbability: 0.02, winChanceAfter: 0.3 } }),
      analyzeFn: confirmingAnalyzeFn({ [AFTER_D4]: -100 }, START_FEN, [["e2e4", 200], ["d2d4", 150]]),
      onProgress: (done, total) => progress.push([done, total]),
      shouldCancel: () => false,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fen: START_FEN, uci: "e2e4", human_probability: 0.02 });
    expect(out[0].trap_gap).toBeGreaterThan(0);
    expect(progress).toEqual([[1, 1]]);
  });

  it("reports trap-phase progress through onTrapProgress while the Stockfish batch runs (#2)", async () => {
    const trapProgress = [];
    // A batch fake that drives onProgress like the real analyzeGamePositions does.
    const confirm = confirmingAnalyzeFn({}, START_FEN, [["e2e4", 200], ["d2d4", 150]]);
    const progressingAnalyzeFn = async ({ positions, onProgress, multipv }) => {
      if (multipv === 3) return confirm({ positions, multipv });
      const out = new Map();
      positions.forEach((p, i) => {
        out.set(p, { score_cp: -100, mate_in: null });
        if (onProgress) onProgress(i + 1, positions.length);
      });
      return out;
    };
    const out = await computeBrilliantAssessments({
      moves,
      evals: ELIGIBLE_REVEALING_EVALS,
      depth: 12,
      rating: 1500,
      provider: fakeProvider({ naturalUci: "d2d4", assessment: { humanProbability: 0.02, winChanceAfter: 0.3 } }),
      analyzeFn: progressingAnalyzeFn,
      onTrapProgress: (done, total) => trapProgress.push([done, total]),
      shouldCancel: () => false,
    });
    expect(out).toHaveLength(1);
    expect(out[0].trap_gap).toBeGreaterThan(0);
    expect(trapProgress).toEqual([[1, 1]]); // one distinct natural-move position, evaluated once
  });

  it("never sends a recapture of the previous move to Maia (shared sanity gate)", async () => {
    const P0 = "rnbqkbnr/ppp2ppp/8/3pp3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 3";
    const P1 = "rnbqkbnr/ppp2ppp/8/3Np3/4P3/8/PPPP1PPP/R1BQKBNR b KQkq - 0 3";
    const P2 = "rnb1kbnr/ppp2ppp/8/3qp3/4P3/8/PPPP1PPP/R1BQKBNR w KQkq - 0 4";
    const seen = [];
    const provider = {
      batch: async (_kind, { items }) => {
        seen.push(...items.map((it) => it.moveUci));
        return items.map(() => ({ humanProbability: 0.5, winChanceAfter: 0.5, naturalUci: null }));
      },
    };
    await computeBrilliantAssessments({
      moves: [
        { fen_before: P0, uci: "c3d5", fen_after: P1, side: "white" },
        { fen_before: P1, uci: "d8d5", fen_after: P2, side: "black" },
      ],
      evals: new Map([[P0, { score_cp: 0, mate_in: null, best_move_uci: "c3d5" }], [P1, { score_cp: 0, mate_in: null, best_move_uci: "d8d5" }], [P2, { score_cp: 0, mate_in: null }]]),
      depth: 12,
      rating: 1500,
      provider,
      analyzeFn: fakeAnalyzeFn({}),
      shouldCancel: () => false,
    });
    expect(seen).toEqual(["c3d5"]);
  });

  it("does NOT attach a trap_gap to an intuitive move (never a candidate, so no extra engine work)", async () => {
    const out = await computeBrilliantAssessments({
      moves,
      evals: ELIGIBLE_REVEALING_EVALS,
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

  it("does NOT assess a Brilliant-ineligible move (winDelta over the cap) — the cheap gate spares a Maia forward", async () => {
    let assessCalls = 0;
    const provider = {
      moveAssessment: async () => {
        assessCalls += 1;
        return { humanProbability: 0.02, winChanceAfter: 0.3 }; // would be unintuitive if asked
      },
      predictions: async () => [{ move_uci: "d2d4" }],
    };
    const out = await computeBrilliantAssessments({
      moves,
      // winBefore ≈ 0.90 (cp 600) but winAfter 0.50 (cp 0) → winDelta ≈ 40 pts > 2, AND the
      // played e2e4 is NOT the engine's best (d2d4 is) → neither eligibility leg passes.
      evals: new Map([
        [START_FEN, { score_cp: 600, mate_in: null, best_move_uci: "d2d4" }],
        [AFTER_E4, { score_cp: 0, mate_in: null }],
      ]),
      depth: 12,
      rating: 1500,
      provider,
      analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
      shouldCancel: () => false,
    });
    expect(out).toHaveLength(0);
    expect(assessCalls).toBe(0); // layer 0 (free) ran first, so no model call at all
  });

  it("assesses a move just inside the 2% boundary the server classifies EXCELLENT, and drops one just outside (excellent_loss = 0.02 parity)", async () => {
    // Pick cp values so the mover-POV loss lands inside (< 2 pts) and outside (> 2 pts) the
    // cap. Inside ⇔ the server classifier labels the move EXCELLENT (loss <= excellent_loss,
    // when not the literal first choice) — one of the two Brilliant-eligible tiers —
    // pinning the same boundary classification.py uses.
    const insideBefore = { score_cp: 0, mate_in: null };
    const insideAfter = { score_cp: -20, mate_in: null }; // loss ≈ 1.84 pts → server EXCELLENT
    const outsideBefore = { score_cp: 0, mate_in: null };
    const outsideAfter = { score_cp: -25, mate_in: null }; // loss ≈ 2.30 pts → server GOOD (not eligible)
    const provider = {
      moveAssessment: async () => ({ humanProbability: 0.02, winChanceAfter: 0.3 }),
      predictions: async () => [{ move_uci: "d2d4" }],
    };
    const inside = await computeBrilliantAssessments({
      moves,
      evals: new Map([
        [START_FEN, { ...insideBefore, best_move_uci: "d2d4" }], // not best → the loss decides
        [AFTER_E4, insideAfter],
      ]),
      depth: 12,
      rating: 1500,
      provider,
      analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
      shouldCancel: () => false,
    });
    const outside = await computeBrilliantAssessments({
      moves,
      evals: new Map([
        [START_FEN, { ...outsideBefore, best_move_uci: "d2d4" }],
        [AFTER_E4, outsideAfter],
      ]),
      depth: 12,
      rating: 1500,
      provider,
      analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
      shouldCancel: () => false,
    });
    expect(inside).toHaveLength(1); // Excellent-tier → assessed
    expect(outside).toHaveLength(0); // server GOOD tier → not assessed
    // Sanity: the two losses really straddle the 2-pt cap on the mover-POV scale.
    // (moverWinChanceAfter takes White-POV {cp, mate}; the eval-map entries above use
    // the analysis-map key names score_cp/mate_in, so re-key them here.)
    const lossOf = (b, a) =>
      (moverWinChanceAfter({ cp: b.score_cp, mate: b.mate_in }, "white") -
        moverWinChanceAfter({ cp: a.score_cp, mate: a.mate_in }, "white")) *
      100;
    expect(lossOf(insideBefore, insideAfter)).toBeLessThan(2);
    expect(lossOf(outsideBefore, outsideAfter)).toBeGreaterThan(2);
  });

  it("treats the engine's literal best move as eligible even when the two searches disagree by > the cap (server BEST bypass)", async () => {
    let assessCalls = 0;
    const provider = {
      moveAssessment: async () => {
        assessCalls += 1;
        return { humanProbability: 0.02, winChanceAfter: 0.3 };
      },
      predictions: async () => [{ move_uci: "d2d4" }],
    };
    const out = await computeBrilliantAssessments({
      moves,
      // winDelta ≈ 40 pts (well over the cap) BUT e2e4 IS best_move_uci → the server would call
      // it BEST, so the assessment must still ship or the server could never flag it brilliant.
      evals: new Map([
        [START_FEN, { score_cp: 600, mate_in: null, best_move_uci: "e2e4" }],
        [AFTER_E4, { score_cp: 0, mate_in: null }],
      ]),
      depth: 12,
      rating: 1500,
      provider,
      analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
      shouldCancel: () => false,
    });
    expect(out).toHaveLength(1);
    expect(assessCalls).toBe(1);
  });

  it("gives a move without a reveal only the shallow Great screen, not the full-depth trap search", async () => {
    let predictionCalls = 0;
    const depths = [];
    const provider = {
      moveAssessment: async () => ({ humanProbability: 0.02, winChanceAfter: 0.62 }), // unintuitive, but...
      predictions: async () => {
        predictionCalls += 1;
        return [{ move_uci: "d2d4" }];
      },
    };
    const out = await computeBrilliantAssessments({
      moves,
      // engineWin ≈ 67.6 (cp 200) vs Maia 62 → reveal ≈ 5.6 < 30: no Brilliant trap search
      evals: ELIGIBLE_REVEALING_EVALS,
      depth: 16,
      rating: 1500,
      provider,
      analyzeFn: async (o) => {
        depths.push(o.depth);
        return fakeAnalyzeFn({ [AFTER_D4]: 150 })(o);
      },
      shouldCancel: () => false,
    });
    expect(out).toHaveLength(1);
    expect(predictionCalls).toBe(1);
    expect(depths).toEqual([10]); // the screen only; the natural move held, so no MultiPV search
    expect(out[0].trap_gap).toBeLessThan(0.1);
    expect("two_move_gap" in out[0]).toBe(false);
  });

  it("skips a move whose assessment is non-finite (Maia inference failed)", async () => {
    const out = await computeBrilliantAssessments({
      moves,
      evals: ELIGIBLE_REVEALING_EVALS,
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

  it("keeps the first-pass assessments when the trap_gap batch throws (#7)", async () => {
    // Eligible + unintuitive + revealing → the move becomes a trap_gap candidate, then the
    // batched Stockfish call in the SECOND pass blows up. The assessment must survive (just
    // without a trap_gap), not vanish along with the whole game's brilliancies.
    const explodingAnalyzeFn = async () => {
      throw new Error("stockfish batch exploded");
    };
    const out = await computeBrilliantAssessments({
      moves,
      evals: ELIGIBLE_REVEALING_EVALS,
      depth: 12,
      rating: 1500,
      provider: fakeProvider({ naturalUci: "d2d4", assessment: { humanProbability: 0.02, winChanceAfter: 0.3 } }),
      analyzeFn: explodingAnalyzeFn,
      shouldCancel: () => false,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fen: START_FEN, uci: "e2e4", human_probability: 0.02 });
    expect("trap_gap" in out[0]).toBe(false); // fail closed on the trap layer only
  });

  it("still propagates a cancel raised during the trap_gap batch (Stop is never swallowed)", async () => {
    // The first pass checks shouldCancel twice for one move (loop top + after the assessment);
    // attachClientTrapGaps' own loop-top check is the 3rd call. Flip true there so the cancel
    // originates inside the SECOND pass — the path the new try/catch must re-throw, not swallow.
    let calls = 0;
    const shouldCancel = () => {
      calls += 1;
      return calls >= 3;
    };
    await expect(
      computeBrilliantAssessments({
        moves,
        evals: ELIGIBLE_REVEALING_EVALS,
        depth: 12,
        rating: 1500,
        provider: fakeProvider({ naturalUci: "d2d4", assessment: { humanProbability: 0.02, winChanceAfter: 0.3 } }),
        analyzeFn: fakeAnalyzeFn({ [AFTER_D4]: -100 }),
        shouldCancel,
      }),
    ).rejects.toMatchObject({ cancelled: true });
  });
});

describe("computeBrilliantAssessments batching", () => {
  // 20 eligible moves (every played move is the engine's best) across two chunks.
  const many = Array.from({ length: 20 }, (_, i) => ({
    ply: i + 1, side: "white", uci: "e2e4", fen_before: `${START_FEN}#${i}`, fen_after: `${AFTER_E4}#${i}`,
  }));
  const evals = new Map(many.flatMap((m) => [
    [m.fen_before, { score_cp: 20, mate_in: null, best_move_uci: "e2e4" }],
    [m.fen_after, { score_cp: 20, mate_in: null }],
  ]));

  it("asks a batching provider once per chunk and keeps per-move order and progress", async () => {
    const calls = [];
    const provider = {
      moveAssessment: async () => { throw new Error("single path must not run"); },
      batch: async (type, { items }) => {
        calls.push(items.length);
        return items.map((_, k) => ({ humanProbability: 0.5, winChanceAfter: 0.5 + k / 1000 }));
      },
      predictions: async () => [],
    };
    const progress = [];
    const out = await computeBrilliantAssessments({
      moves: many, evals, depth: 12, rating: 1500, provider,
      analyzeFn: fakeAnalyzeFn({}), shouldCancel: () => false,
      onProgress: (done) => progress.push(done),
    });
    expect(calls).toEqual([16, 4]);
    expect(out).toHaveLength(20);
    expect(out.map((a) => a.fen)).toEqual(many.map((m) => m.fen_before));
    expect(progress.at(-1)).toBe(20);
  });

  it("a Stop during a batch records nothing from it", async () => {
    let stop = false;
    const provider = {
      batch: async (type, { items }) => { stop = true; return items.map(() => ({ humanProbability: 0.5, winChanceAfter: 0.5 })); },
      predictions: async () => [],
    };
    await expect(computeBrilliantAssessments({
      moves: many, evals, depth: 12, rating: 1500, provider,
      analyzeFn: fakeAnalyzeFn({}), shouldCancel: () => stop,
    })).rejects.toMatchObject({ cancelled: true });
  });
});

describe("attachAlternativeGaps (deep confirmation)", () => {
  const wc = (cp) => moverWinChanceAfter({ cp, mate: null }, "white");
  const base = { depth: 16, shouldCancel: () => false, cancelledError };
  const evals = new Map([
    [START_FEN, { score_cp: 30, mate_in: null, best_move_uci: "e2e4" }],
    [AFTER_E4, { score_cp: 30, mate_in: null, pv: ["e7e5"] }],
  ]);
  const read = (lines) => {
    const [[best, cp], second, third] = lines;
    const line = (l) => (l ? { move_uci: l[0], score_cp: l[1], mate_in: null } : null);
    return new Map([[START_FEN, { score_cp: cp, mate_in: null, best_move_uci: best, second: line(second), third: line(third) }]]);
  };

  it("reads both gaps from one MultiPV-3 search deeper than the analysis", async () => {
    const cand = brilliantCandidate({ item: { fen: START_FEN, uci: "e2e4", trap_gap: 0.2 } });
    const calls = [];
    await attachAlternativeGaps({
      ...base,
      candidates: [cand],
      evals,
      analyzeFn: async (o) => {
        calls.push(o);
        return read([["e2e4", 30], ["d2d4", 10], ["g1f3", -250]]);
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ multipv: 3, depth: 18, positions: [START_FEN] });
    expect(cand.item.only_move_gap).toBeCloseTo(wc(30) - wc(10), 10);
    expect(cand.item.two_move_gap).toBeCloseTo(wc(30) - wc(-250), 10);
    expect(cand.item.trap_gap).toBe(0.2);
  });

  it("measures a move that isn't the first choice against that choice", async () => {
    const cand = brilliantCandidate({ item: { fen: START_FEN, uci: "e2e4", trap_gap: 0.2 } });
    await attachAlternativeGaps({ ...base, candidates: [cand], evals, analyzeFn: async () => read([["d2d4", 40], ["e2e4", 30]]) });
    expect(cand.item.only_move_gap).toBeCloseTo(wc(30) - wc(40), 10);
  });

  it("drops the trap_gap of a move that falls out of the top three at depth", async () => {
    const cand = brilliantCandidate({ item: { fen: START_FEN, uci: "e2e4", trap_gap: 0.2 } });
    await attachAlternativeGaps({ ...base, candidates: [cand], evals, analyzeFn: async () => read([["d2d4", 60], ["c2c4", 55], ["g1f3", 50]]) });
    expect("trap_gap" in cand.item).toBe(false);
    expect(cand.item.only_move_gap).toBeUndefined();
  });

  it("drops the trap_gap of a move whose own score drifts at depth", async () => {
    const cand = brilliantCandidate({ item: { fen: START_FEN, uci: "e2e4", trap_gap: 0.2 } });
    // Analysis: +0.30; confirmation: −2.00 for the same move.
    await attachAlternativeGaps({ ...base, candidates: [cand], evals, analyzeFn: async () => read([["d2d4", -150], ["e2e4", -200]]) });
    expect("trap_gap" in cand.item).toBe(false);
  });

  it("drops the trap_gap when the confirmation read is missing (fail closed)", async () => {
    const cand = brilliantCandidate({ item: { fen: START_FEN, uci: "e2e4", trap_gap: 0.2 } });
    await attachAlternativeGaps({ ...base, candidates: [cand], evals, analyzeFn: async () => new Map() });
    expect("trap_gap" in cand.item).toBe(false);
  });

  it("skips candidates the trap layer already rejected", async () => {
    const cand = brilliantCandidate({ item: { fen: START_FEN, uci: "e2e4", trap_gap: 0.01 } });
    await attachAlternativeGaps({ ...base, candidates: [cand], evals, analyzeFn: async () => { throw new Error("no search expected"); } });
    expect(cand.item.only_move_gap).toBeUndefined();
    expect(cand.item.trap_gap).toBe(0.01);
  });

  it("searches a position once when it is both a brilliancy and a critical candidate", async () => {
    const item = { fen: START_FEN, uci: "e2e4", trap_gap: 0.2 };
    const calls = [];
    await attachAlternativeGaps({
      ...base,
      candidates: [brilliantCandidate({ item })],
      critical: [brilliantCandidate({ item })],
      evals,
      analyzeFn: async (o) => {
        calls.push(o);
        return read([["e2e4", 30], ["d2d4", -200]]);
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].positions).toEqual([START_FEN]);
    expect(item.two_move_gap).toBeUndefined();
  });
});

describe("createBrilliantAssessor (Maia streams alongside Stockfish)", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    ply: i + 1, side: "white", uci: "e2e4", fen_before: `${START_FEN}#${i}`, fen_after: `${AFTER_E4}#${i}`,
  }));
  const evalsOf = (moves) => new Map(moves.flatMap((m) => [
    [m.fen_before, { score_cp: 20, mate_in: null, best_move_uci: "e2e4" }],
    [m.fen_after, { score_cp: 20, mate_in: null }],
  ]));
  const batchingProvider = (log, { failFirst = false } = {}) => ({
    batch: async (type, { items }) => {
      log.push(items.length);
      if (failFirst && log.length === 1) throw new Error("Maia init failed");
      return items.map(() => ({ humanProbability: 0.5, winChanceAfter: 0.5, naturalUci: "e2e4" }));
    },
    predictions: async () => { throw new Error("the batch already named the natural move"); },
  });

  it("assesses moves while the main pass is still running, and finish() only drains the rest", async () => {
    const calls = [];
    const a = createBrilliantAssessor({
      moves: many, depth: 16, rating: 1500, provider: batchingProvider(calls),
      analyzeFn: fakeAnalyzeFn({}), shouldCancel: () => false,
    });
    const evals = evalsOf(many);
    // Stockfish finishes the first 16 moves' positions…
    for (const m of many.slice(0, 16)) {
      a.push(m.fen_before, evals.get(m.fen_before));
      a.push(m.fen_after, evals.get(m.fen_after));
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([16]); // …and Maia has already answered them
    const out = await a.finish(evals);
    expect(calls).toEqual([16, 4]);
    expect(out.map((x) => x.fen)).toEqual(many.map((m) => m.fen_before));
  });

  it("waits for both positions of a move before deciding it", async () => {
    const calls = [];
    const a = createBrilliantAssessor({
      moves: many.slice(0, 1), depth: 16, rating: 1500, provider: batchingProvider(calls),
      analyzeFn: fakeAnalyzeFn({}), shouldCancel: () => false,
    });
    const evals = evalsOf(many.slice(0, 1));
    a.push(many[0].fen_before, evals.get(many[0].fen_before));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
    expect(await a.finish(evals)).toHaveLength(1);
  });

  it("retries a chunk that failed mid-stream (e.g. Maia's init) when the pass finishes", async () => {
    const calls = [];
    const a = createBrilliantAssessor({
      moves: many, depth: 16, rating: 1500, provider: batchingProvider(calls, { failFirst: true }),
      analyzeFn: fakeAnalyzeFn({}), shouldCancel: () => false,
    });
    const evals = evalsOf(many);
    for (const [fen, ev] of evals) a.push(fen, ev);
    const out = await a.finish(evals);
    expect(out).toHaveLength(20);
    expect(calls).toEqual([16, 16, 4]); // the failed chunk goes again with the rest
  });

  it("surfaces a Stop that arrived while streaming", async () => {
    let stop = false;
    const a = createBrilliantAssessor({
      moves: many, depth: 16, rating: 1500,
      provider: { batch: async (type, { items }) => { stop = true; return items.map(() => ({ humanProbability: 0.5, winChanceAfter: 0.5 })); } },
      analyzeFn: fakeAnalyzeFn({}), shouldCancel: () => stop,
    });
    const evals = evalsOf(many);
    for (const [fen, ev] of evals) a.push(fen, ev);
    await expect(a.finish(evals)).rejects.toMatchObject({ cancelled: true });
  });
});

describe("Great critical-find funnel", () => {
  const moves = [{ fen_before: START_FEN, uci: "e2e4", fen_after: AFTER_E4, side: "white" }];
  const evals = new Map([
    [START_FEN, { score_cp: 100, mate_in: null, best_move_uci: "e2e4" }],
    [AFTER_E4, { score_cp: 100, mate_in: null }],
  ]);
  // 25% of players find it and Maia's first glance agrees with the engine: never a Brilliant
  // candidate, only a Great one.
  const provider = (naturalUci) => ({
    batch: async (type, { items }) => items.map(() => ({ humanProbability: 0.25, winChanceAfter: 0.6, naturalUci })),
    predictions: async () => { throw new Error("the batch already named the natural move"); },
  });

  it("screens the natural move shallow, then searches MultiPV-3 only because it failed", async () => {
    const calls = [];
    const out = await computeBrilliantAssessments({
      moves, evals, depth: 16, rating: 1500, provider: provider("d2d4"), shouldCancel: () => false,
      analyzeFn: async (o) => {
        calls.push({ depth: o.depth, multipv: o.multipv, positions: o.positions });
        if (o.multipv === 1) return new Map([[AFTER_D4, { score_cp: -150, mate_in: null }]]);
        return new Map([[START_FEN, {
          score_cp: 100, mate_in: null, best_move_uci: "e2e4",
          second: { move_uci: "c2c4", score_cp: 90, mate_in: null },
          third: { move_uci: "g1f3", score_cp: -200, mate_in: null },
        }]]);
      },
    });
    expect(calls).toEqual([
      { depth: 10, multipv: 1, positions: [AFTER_D4] },
      // The screen failed the natural move: read it again at the analysis depth...
      { depth: 16, multipv: 1, positions: [AFTER_D4] },
      // ...then confirm deeper than the analysis.
      { depth: 18, multipv: 3, positions: [START_FEN] },
    ]);
    expect(out[0].trap_gap).toBeGreaterThan(0.1);
    expect(out[0].two_move_gap).toBeGreaterThan(0.1);
  });

  it("drops a screen hit that the analysis-depth read of the natural move overturns", async () => {
    const calls = [];
    const out = await computeBrilliantAssessments({
      moves, evals, depth: 16, rating: 1500, provider: provider("d2d4"), shouldCancel: () => false,
      analyzeFn: async (o) => {
        calls.push(o.depth);
        if (o.multipv === 3) throw new Error("no confirmation expected");
        // Shallow: d4 looks bad. At depth 16 it holds as well as e4.
        return new Map([[AFTER_D4, { score_cp: o.depth < 16 ? -150 : 95, mate_in: null }]]);
      },
    });
    expect(calls).toEqual([10, 16]);
    expect(out[0].trap_gap).toBeLessThan(0.1);
    expect(out[0].two_move_gap).toBeUndefined();
  });

  it("costs no search at all when the natural move is the played one or the engine's first choice", async () => {
    const noSearch = async () => { throw new Error("no search expected"); };
    const same = await computeBrilliantAssessments({ moves, evals, depth: 16, rating: 1500, provider: provider("e2e4"), analyzeFn: noSearch, shouldCancel: () => false });
    expect(same[0].trap_gap).toBe(0);
    const notBest = new Map(evals);
    notBest.set(START_FEN, { score_cp: 110, mate_in: null, best_move_uci: "d2d4" });
    const best = await computeBrilliantAssessments({ moves, evals: notBest, depth: 16, rating: 1500, provider: provider("d2d4"), analyzeFn: noSearch, shouldCancel: () => false });
    expect(best[0].trap_gap).toBeCloseTo(moverWinChanceAfter({ cp: 100, mate: null }, "white") - moverWinChanceAfter({ cp: 110, mate: null }, "white"), 10);
  });

  it("skips a decided game", async () => {
    const decided = new Map([
      [START_FEN, { score_cp: 900, mate_in: null, best_move_uci: "e2e4" }],
      [AFTER_E4, { score_cp: 900, mate_in: null }],
    ]);
    const out = await computeBrilliantAssessments({
      moves, evals: decided, depth: 16, rating: 1500, provider: provider("d2d4"), shouldCancel: () => false,
      analyzeFn: async () => { throw new Error("no search expected"); },
    });
    expect("trap_gap" in out[0]).toBe(false);
  });
});
