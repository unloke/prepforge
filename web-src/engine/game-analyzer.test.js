import { describe, it, expect, vi } from "vitest";
import { createEngineProfileManager, CRASH_KEY } from "./engine-profile.js";

import {
  isTerminalPosition,
  terminalEval,
  analyzeGamePositions,
  AnalysisCancelled,
  resolveConcurrency,
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

describe("analysis worker budget", () => {
  it("caps explicit requests as well as automatic requests", () => {
    expect(resolveConcurrency(64)).toBe(3);
    expect(resolveConcurrency(1)).toBe(1);
    expect(resolveConcurrency(2.5)).toBe(2);
    expect(resolveConcurrency(Infinity)).toBeGreaterThanOrEqual(1);
    expect(resolveConcurrency(Infinity)).toBeLessThanOrEqual(3);
  });
});

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

  it("stores the final PV's SAN even though the provider sends UCI only", async () => {
    const out = await analyzeGamePositions({
      positions: [START_FEN],
      depth: 12,
      concurrency: 1,
      createProvider: makeFakeProviderFactory({ order: [START_FEN] }),
    });
    const ev = out.get(START_FEN);
    expect(ev.pv).toEqual(["e2e4"]);
    expect(ev.pv_san).toEqual(["e4"]);
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

  it("cancels even while a provider is queued for allocation", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const close = vi.fn(async () => {});
      const result = analyzeGamePositions({ positions: [START_FEN], depth: 12, concurrency: 1,
        shouldCancel: () => cancelled,
        createProvider: () => ({ open: () => new Promise(() => {}), close }),
      }).catch((error) => error);
      cancelled = true;
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toBeInstanceOf(AnalysisCancelled);
      expect(close).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("bounds allocation and handshake waits by the startup deadline", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(async () => {});
      const result = analyzeGamePositions({ positions: [START_FEN], depth: 12, concurrency: 1,
        createProvider: () => ({ open: () => new Promise(() => {}), close }),
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(60000);
      expect((await result).message).toMatch(/startup timed out/);
      expect(close).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
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

  it("throws on a wedged non-terminal search instead of fabricating a 0.00 eval", async () => {
    // A provider whose search never produces a line and never stops — the wedged-engine shape.
    // waitForEval must NOT fall through to terminalEval's draw-ish 0 for a non-terminal FEN.
    const wedgedFactory = () => ({
      async open() {},
      async update() {},
      snapshot() {
        return { running: true, current_depth: 0, pvs: [], error: null, fen: null };
      },
      async close() {},
    });

    vi.useFakeTimers();
    try {
      const settled = analyzeGamePositions({
        positions: [START_FEN], // non-terminal
        depth: 12,
        concurrency: 1,
        createProvider: wedgedFactory,
      }).then(
        () => ({ ok: true }),
        (err) => ({ err }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(31000); // drive the poll loop past PER_POSITION_TIMEOUT_MS
      const result = await settled;
      expect(result.ok).toBeUndefined();
      expect(result.err).toBeInstanceOf(Error);
      expect(result.err.message).toMatch(/no evaluation/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

function managedRun(profile = { net: "big", workers: 2 }) {
  const data = new Map();
  const manager = createEngineProfileManager({ assetState: () => ({ phase: "ready" }), beginSession: () => () => {},
    // A real desktop reports both signals; a device with no memory signal is the
    // phone-safe case and is covered by its own test.
    device: () => ({ hardwareConcurrency: 8, deviceMemory: 8 }),
    subscribeAsset: () => () => {}, storage: () => ({ getItem: k => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }) });
  manager.setEngineProfile(profile);
  return { manager, data, engineRun: manager.createEngineAnalysisRun() };
}

describe("analysis crash guard and single retry", () => {
  it("holds one guard across every position and follow-up batch until the owner ends the run", async () => {
    const f = managedRun();
    const factory = vi.fn(makeFakeProviderFactory({ order: NON_TERMINAL }));
    const marks = [];
    const onResult = vi.fn(() => marks.push(JSON.parse(f.data.get(CRASH_KEY))));
    await analyzeGamePositions({ positions: NON_TERMINAL, depth: 12, createProvider: factory,
      engineRun: f.engineRun, onResult });
    expect(onResult).toHaveBeenCalledTimes(NON_TERMINAL.length);
    expect(marks).toEqual(NON_TERMINAL.map(() => expect.objectContaining({ net: "big", workers: 2 })));
    expect(f.data.has(CRASH_KEY)).toBe(true);
    await analyzeGamePositions({ positions: NON_TERMINAL.slice(0, 1), depth: 14, createProvider: factory,
      engineRun: f.engineRun });
    expect(f.data.has(CRASH_KEY)).toBe(true);
    expect(factory.mock.calls.every(([o]) => o.profileManaged === false && o.net === "big")).toBe(true);
    f.engineRun.done();
    expect(f.data.has(CRASH_KEY)).toBe(false);
  });

  it.each([new Error("OOM"), new Error("Aborted(memory access)"), new RangeError("no address space"),
    new Error("Browser engine could not start: load failed")])("retries %s once on the same net and preserves completed positions", async failure => {
    const f = managedRun({ net: "big", workers: 2 });
    const searched = [], nets = [], cache = new Map();
    // This is the store's profile-change behaviour: its engine-derived cache is cleared.
    f.manager.subscribeEngineProfile(() => cache.clear());
    const good = makeFakeProviderFactory({ order: NON_TERMINAL });
    const factory = opts => {
      nets.push(opts.net);
      const provider = good();
      const open = provider.open, update = provider.update;
      provider.open = async o => {
        searched.push(o.fen);
        if (f.engineRun.profile().workers === 2 && o.fen === NON_TERMINAL[1]) throw failure;
        return open(o);
      };
      provider.update = async o => {
        searched.push(o.fen);
        if (f.engineRun.profile().workers === 2 && o.fen === NON_TERMINAL[1]) throw failure;
        return update(o);
      };
      return provider;
    };
    const result = await analyzeGamePositions({ positions: NON_TERMINAL.slice(0, 3), depth: 12, concurrency: 1,
      engineRun: f.engineRun, createProvider: factory, reuse: fen => cache.get(fen),
      onResult: (fen, ev) => cache.set(fen, ev) });
    expect(nets).toEqual(["big", "big"]);
    expect(searched).toEqual([NON_TERMINAL[0], NON_TERMINAL[1], NON_TERMINAL[1], NON_TERMINAL[2]]);
    expect([...result.keys()]).toEqual(NON_TERMINAL.slice(0, 3));
    expect(cache.size).toBe(3);
    expect(f.manager.engineProfile()).toMatchObject({ net: "big", workers: 1 });
    f.engineRun.done();
    expect(f.data.has(CRASH_KEY)).toBe(false);
  });

  it("records lite for the next session instead of mixing nets after big 1 fails", async () => {
    const f = managedRun({ net: "big", workers: 1 });
    const createProvider = vi.fn(() => ({ open: async () => { throw new Error("OOM"); }, close: async () => {} }));
    await expect(analyzeGamePositions({ positions: [START_FEN], depth: 12, engineRun: f.engineRun,
      createProvider })).rejects.toThrow("OOM");
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(f.engineRun.profile().net).toBe("big");
    f.engineRun.done();
    expect(f.manager.usableEngineProfile()).toMatchObject({ net: "lite", workers: 1 });
  });

  it("keeps the main pass and follow-up batches on their starting net after a profile change", async () => {
    const f = managedRun({ net: "lite", workers: 1 });
    const factory = vi.fn(makeFakeProviderFactory({ order: NON_TERMINAL }));
    await analyzeGamePositions({ positions: [START_FEN], depth: 19, engineRun: f.engineRun, createProvider: factory,
      onResult: () => f.manager.setEngineProfile({ net: "big", workers: 3 }) });
    await analyzeGamePositions({ positions: [NON_TERMINAL[1]], depth: 19, engineRun: f.engineRun, createProvider: factory });
    expect(factory.mock.calls.map(([o]) => [o.net, o.maxDepth])).toEqual([["lite", 19], ["lite", 19]]);
    f.engineRun.done();
    expect(f.manager.usableEngineProfile()).toMatchObject({ net: "big", workers: 3 });
  });

  it("surfaces the second failure, with no third attempt", async () => {
    const f = managedRun({ net: "big", workers: 3 });
    const failure = new Error("Aborted(OOM)");
    const close = vi.fn(async () => {});
    const createProvider = vi.fn(() => ({ open: async () => { throw failure; }, close }));
    await expect(analyzeGamePositions({ positions: [START_FEN], depth: 12, concurrency: 1,
      engineRun: f.engineRun, createProvider })).rejects.toBe(failure);
    expect(createProvider).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(f.engineRun.error).toBe(failure);
    expect(f.manager.engineProfile()).toMatchObject({ net: "big", workers: 1 });
    f.engineRun.done();
    expect(f.data.has(CRASH_KEY)).toBe(false);
  });

  it("does not grant a fresh retry to a later batch of the same analysis", async () => {
    const f = managedRun({ net: "big", workers: 3 });
    const good = makeFakeProviderFactory({ order: NON_TERMINAL });
    let created = 0;
    const createProvider = vi.fn(() => ++created === 2 ? good() : {
      open: async () => { throw new Error("OOM"); }, close: async () => {},
    });
    await analyzeGamePositions({ positions: [START_FEN], depth: 12, concurrency: 1, engineRun: f.engineRun, createProvider });
    await expect(analyzeGamePositions({ positions: [START_FEN], depth: 14, concurrency: 1,
      engineRun: f.engineRun, createProvider })).rejects.toThrow("OOM");
    expect(createProvider).toHaveBeenCalledTimes(3);
    f.engineRun.done();
  });

  it("preserves the OOM from a later worker when the first worker reports cancellation", async () => {
    vi.useFakeTimers();
    const f = managedRun();
    try {
      let created = 0;
      const good = makeFakeProviderFactory({ order: NON_TERMINAL });
      const factory = vi.fn(() => {
        const index = created++;
        if (index > 1) return good();
        return { open: () => index === 0 ? new Promise(() => {}) : Promise.reject(new Error("OOM")), close: async () => {} };
      });
      const result = analyzeGamePositions({ positions: NON_TERMINAL.slice(0, 2), depth: 12,
        engineRun: f.engineRun, createProvider: factory });
      await vi.advanceTimersByTimeAsync(100);
      expect((await result).size).toBe(2);
      expect(factory).toHaveBeenCalledTimes(3); // two workers, then one after step-down
      expect(f.manager.engineProfile()).toMatchObject({ net: "big", workers: 1 });
    } finally { f.engineRun.done(); vi.useRealTimers(); }
  });

  it("retries a startup timeout once and closes both failed providers", async () => {
    vi.useFakeTimers();
    const f = managedRun();
    try {
      const close = vi.fn(async () => {});
      const createProvider = vi.fn(() => ({ open: () => new Promise(() => {}), close }));
      const result = analyzeGamePositions({ positions: [START_FEN], depth: 12,
        engineRun: f.engineRun, createProvider }).catch(error => error);
      await vi.advanceTimersByTimeAsync(120000);
      expect((await result).message).toMatch(/startup timed out/);
      expect(createProvider).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalled();
    } finally { f.engineRun.done(); vi.useRealTimers(); }
    expect(f.data.has(CRASH_KEY)).toBe(false);
  });

  it.each(["cancel", "ordinary error", "lite baseline"])("does not retry %s", async kind => {
    const f = managedRun(kind === "lite baseline" ? { net: "lite", workers: 1 } : undefined);
    const failure = new Error(kind === "ordinary error" ? "bad position" : "OOM");
    const createProvider = vi.fn(() => ({ open: async () => { throw failure; }, close: async () => {} }));
    const result = analyzeGamePositions({ positions: [START_FEN], depth: 12, engineRun: f.engineRun,
      createProvider, shouldCancel: () => kind === "cancel" });
    await expect(result).rejects.toBeInstanceOf(kind === "cancel" ? AnalysisCancelled : Error);
    expect(createProvider).toHaveBeenCalledTimes(1);
    f.engineRun.done();
    expect(f.data.has(CRASH_KEY)).toBe(false);
  });
});
