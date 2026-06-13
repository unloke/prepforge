import { describe, it, expect } from "vitest";

import {
  isTerminalPosition,
  terminalEval,
  analyzeGamePositions,
  AnalysisCancelled,
} from "./game-analyzer.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// Fool's mate: 1. f3 e5 2. g4 Qh4# — Black has delivered mate, White to move.
const WHITE_MATED_FEN =
  "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
// Scholar's mate: after Qxf7#, Black is checkmated, Black to move.
const BLACK_MATED_FEN =
  "r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4";
// Classic stalemate: Black to move, no legal moves, not in check.
const STALEMATE_FEN = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";

describe("isTerminalPosition", () => {
  it("is false for a normal position with legal moves", () => {
    expect(isTerminalPosition(START_FEN)).toBe(false);
  });

  it("is true for checkmate and stalemate (so the engine is skipped)", () => {
    expect(isTerminalPosition(WHITE_MATED_FEN)).toBe(true);
    expect(isTerminalPosition(BLACK_MATED_FEN)).toBe(true);
    expect(isTerminalPosition(STALEMATE_FEN)).toBe(true);
  });

  it("is false (not terminal) for an unparseable FEN", () => {
    expect(isTerminalPosition("not a fen")).toBe(false);
  });
});

describe("terminalEval", () => {
  it("saturates negative when White is checkmated", () => {
    const ev = terminalEval(WHITE_MATED_FEN);
    expect(ev.score_cp).toBe(-100000);
    expect(ev.best_move_uci).toBe(null);
  });

  it("saturates positive when Black is checkmated", () => {
    const ev = terminalEval(BLACK_MATED_FEN);
    expect(ev.score_cp).toBe(100000);
  });

  it("is a draw (0) for stalemate", () => {
    const ev = terminalEval(STALEMATE_FEN);
    expect(ev.score_cp).toBe(0);
  });
});

// Six legal, non-terminal opening positions used to drive the worker pool.
const NON_TERMINAL = [
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
  "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
  "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
];

// Fake provider that "finishes" each search immediately, encoding the FEN's
// position in `order` as its score so deterministic ordering can be asserted.
// `delays` (optional, keyed by fen) lets a position resolve asynchronously so we
// can exercise concurrent workers pulling from the shared queue.
function makeFakeProviderFactory({ order, delays = {}, onCreate, opensThrow } = {}) {
  return function createFakeProvider() {
    if (onCreate) onCreate();
    let snap = { running: false, current_depth: 0, pvs: [], error: null, fen: null };
    async function ready(fen) {
      if (opensThrow) throw new Error("provider exploded");
      if (delays[fen]) await new Promise((r) => setTimeout(r, delays[fen]));
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
        await ready(fen);
      },
      async update({ fen }) {
        await ready(fen);
      },
      snapshot() {
        return snap;
      },
      async close() {},
    };
  };
}

describe("analyzeGamePositions (worker pool)", () => {
  it("returns an empty map for no positions without creating a provider", async () => {
    let created = 0;
    const out = await analyzeGamePositions({
      positions: [],
      depth: 12,
      createProvider: makeFakeProviderFactory({ order: [], onCreate: () => (created += 1) }),
    });
    expect(out.size).toBe(0);
    expect(created).toBe(0);
  });

  it("evaluates every position, keyed by fen, regardless of worker count", async () => {
    // Stagger delays so workers finish out of order; ordering must still hold.
    const delays = { [NON_TERMINAL[0]]: 30, [NON_TERMINAL[3]]: 20 };
    const out = await analyzeGamePositions({
      positions: NON_TERMINAL,
      depth: 12,
      concurrency: 3,
      createProvider: makeFakeProviderFactory({ order: NON_TERMINAL, delays }),
    });
    expect(out.size).toBe(NON_TERMINAL.length);
    NON_TERMINAL.forEach((fen, i) => {
      expect(out.get(fen).score_cp).toBe(i);
    });
  });

  it("reports cumulative progress up to the total exactly once per position", async () => {
    const seen = [];
    await analyzeGamePositions({
      positions: NON_TERMINAL,
      depth: 12,
      concurrency: 2,
      createProvider: makeFakeProviderFactory({ order: NON_TERMINAL }),
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.length).toBe(NON_TERMINAL.length);
    expect(seen.map(([d]) => d).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen.every(([, total]) => total === NON_TERMINAL.length)).toBe(true);
  });

  it("handles terminal positions without invoking the engine", async () => {
    const positions = [NON_TERMINAL[0], BLACK_MATED_FEN, NON_TERMINAL[1]];
    const out = await analyzeGamePositions({
      positions,
      depth: 12,
      concurrency: 2,
      createProvider: makeFakeProviderFactory({ order: positions }),
    });
    expect(out.get(BLACK_MATED_FEN).score_cp).toBe(100000);
    expect(out.size).toBe(3);
  });

  it("caps the worker count at the number of positions", async () => {
    let created = 0;
    await analyzeGamePositions({
      positions: NON_TERMINAL.slice(0, 2),
      depth: 12,
      concurrency: 8,
      createProvider: makeFakeProviderFactory({
        order: NON_TERMINAL,
        onCreate: () => (created += 1),
      }),
    });
    expect(created).toBe(2);
  });

  it("throws AnalysisCancelled when cancelled and stops processing", async () => {
    const seen = [];
    await expect(
      analyzeGamePositions({
        positions: NON_TERMINAL,
        depth: 12,
        concurrency: 2,
        shouldCancel: () => true,
        createProvider: makeFakeProviderFactory({ order: NON_TERMINAL }),
        onProgress: (done) => seen.push(done),
      }),
    ).rejects.toBeInstanceOf(AnalysisCancelled);
    expect(seen).toEqual([]);
  });

  it("propagates a provider failure to the caller", async () => {
    await expect(
      analyzeGamePositions({
        positions: NON_TERMINAL,
        depth: 12,
        concurrency: 2,
        createProvider: makeFakeProviderFactory({ order: NON_TERMINAL, opensThrow: true }),
      }),
    ).rejects.toThrow("provider exploded");
  });
});
