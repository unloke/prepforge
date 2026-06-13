import { describe, it, expect } from "vitest";

import { analyzeGamePositions, resolveConcurrency } from "./game-analyzer.js";

// VERIFICATION HARNESS (does not modify game-analyzer.js).
//
// Question under test: "with multiple Analyze workers, can two workers ever end up
// computing the same position?" These tests instrument a fake Stockfish provider so we
// can record, per provider instance (= per worker), every FEN it was asked to evaluate
// and in what order. From that ledger we can prove or disprove each claim precisely:
//
//   Claim 1 (race): no game *index* is ever handed to two workers.        -> PROVEN true.
//   Claim 2 (distinct input): each distinct FEN reaches the engine once.  -> depends on dedup.
//   Claim 3 (duplicate input): if `positions` contains a repeated FEN, is
//            that FEN searched more than once across the pool?            -> the real question.
//
// The live UI never sends duplicate FENs because /api/analyze/prepare dedups them server
// side, but analyzeGamePositions is the unit under test here: its OWN robustness is what
// these assertions pin down, independent of any caller.

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const A = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const B = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const C = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
const D = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";

// A fake provider whose every search resolves after `delayMs` (so workers genuinely
// overlap), recording each searched FEN into the SHARED `ledger`. Each provider instance
// gets a unique workerId so we can attribute searches to workers. The score encodes the
// FEN's index in `order` so result correctness is checkable too.
function makeRecordingFactory(ledger, order, delayMs = 5) {
  let nextWorkerId = 0;
  return function createRecordingProvider() {
    const workerId = nextWorkerId++;
    ledger.workers.add(workerId);
    let snap = { running: false, current_depth: 0, pvs: [], error: null, fen: null };
    async function run(fen) {
      ledger.searches.push({ workerId, fen });
      // Hold the position "in flight" so siblings run concurrently — this is what would
      // expose two workers racing on the same FEN if dispatch were unsafe.
      await new Promise((r) => setTimeout(r, delayMs));
      snap = {
        running: false,
        current_depth: 99,
        error: null,
        fen,
        pvs: [{ score_cp: order.indexOf(fen), mate_in: null, pv_uci: ["e2e4"] }],
      };
    }
    return {
      async open({ fen }) {
        await run(fen);
      },
      async update({ fen }) {
        await run(fen);
      },
      snapshot() {
        return snap;
      },
      async close() {},
    };
  };
}

function countByFen(searches) {
  const counts = new Map();
  for (const { fen } of searches) counts.set(fen, (counts.get(fen) || 0) + 1);
  return counts;
}

describe("Claim 1 — index dispatch is race-free across concurrent workers", () => {
  it("never sends the same distinct position to the engine twice (no index handed out twice)", async () => {
    const ledger = { searches: [], workers: new Set() };
    const positions = [START, A, B, C, D];
    await analyzeGamePositions({
      positions,
      depth: 12,
      concurrency: 4,
      createProvider: makeRecordingFactory(ledger, positions),
    });

    // Every distinct position searched exactly once: takeNextPosition() reads-and-increments
    // nextIndex with no `await` between, so under the single-threaded event loop no two
    // workers can ever pull the same index. This is the analyst's "no duplicate" claim.
    const counts = countByFen(ledger.searches);
    for (const fen of positions) expect(counts.get(fen)).toBe(1);
    expect(ledger.searches.length).toBe(positions.length);
  });

  it("actually spreads work across multiple workers (not a serial degenerate)", async () => {
    const ledger = { searches: [], workers: new Set() };
    const positions = [START, A, B, C, D];
    await analyzeGamePositions({
      positions,
      depth: 12,
      concurrency: 3,
      createProvider: makeRecordingFactory(ledger, positions, 8),
    });
    // With 5 overlapping positions and concurrency 3, the pool must use >1 worker.
    expect(ledger.workers.size).toBeGreaterThan(1);
    expect(ledger.workers.size).toBeLessThanOrEqual(3);
  });
});

describe("Claim 2/3 — duplicate FENs in the input", () => {
  it("dedups: a FEN repeated across indices reaches the engine only ONCE", async () => {
    // positions has A three times and B twice — a caller that forgot to dedup, or a game
    // with a repeated position. The pool must not burn redundant searches on them.
    const ledger = { searches: [], workers: new Set() };
    const positions = [START, A, B, A, C, B, A];
    const out = await analyzeGamePositions({
      positions,
      depth: 12,
      concurrency: 4,
      createProvider: makeRecordingFactory(ledger, positions),
    });

    const counts = countByFen(ledger.searches);
    // Each DISTINCT FEN searched exactly once despite the repeats.
    expect(counts.get(A)).toBe(1);
    expect(counts.get(B)).toBe(1);
    expect(counts.get(START)).toBe(1);
    expect(counts.get(C)).toBe(1);
    expect(ledger.searches.length).toBe(4); // 4 distinct FENs, not 7

    // …and the result still has an entry for every distinct FEN, fanned out correctly.
    expect(out.size).toBe(4);
    expect(out.get(A).score_cp).toBe(positions.indexOf(A));
    expect(out.get(B).score_cp).toBe(positions.indexOf(B));
  });

  it("explicit concurrency is honoured verbatim", () => {
    expect(resolveConcurrency(3)).toBe(3);
    expect(resolveConcurrency(1)).toBe(1);
  });

  it("default concurrency reserves a core and is clamped to [1, 6]", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const setHw = (n) =>
      Object.defineProperty(globalThis, "navigator", {
        value: { hardwareConcurrency: n },
        configurable: true,
      });
    try {
      setHw(8);
      expect(resolveConcurrency()).toBe(6); // min(6, 8-1)
      setHw(4);
      expect(resolveConcurrency()).toBe(3); // 4-1
      setHw(1);
      expect(resolveConcurrency()).toBe(1); // never below 1
    } finally {
      if (desc) Object.defineProperty(globalThis, "navigator", desc);
      else delete globalThis.navigator;
    }
  });

  it("progress still climbs to the full position total even with duplicates", async () => {
    const ledger = { searches: [], workers: new Set() };
    const positions = [A, A, B, B, B];
    const seen = [];
    await analyzeGamePositions({
      positions,
      depth: 12,
      concurrency: 2,
      createProvider: makeRecordingFactory(ledger, positions),
      onProgress: (done, total) => seen.push([done, total]),
    });
    // Total reported is the original count (what the toast shows); the bar reaches it.
    expect(seen[seen.length - 1]).toEqual([positions.length, positions.length]);
    expect(seen.every(([, total]) => total === positions.length)).toBe(true);
  });
});
