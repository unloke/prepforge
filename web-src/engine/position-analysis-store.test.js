import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPositionAnalysisStore, positionKey } from "./position-analysis-store.js";
import { analyzeGamePositions } from "./game-analyzer.js";

const A = "8/8/8/8/8/8/R7/K6k w - - 0 1";
const B = "8/8/8/8/8/8/R7/K6k b - - 0 1";
const C = "8/8/8/8/8/8/RK5k/8 w - - 0 1";

let store;
let workers;
// A fake EngineProvider: one "worker" per provider, switching positions with update.
function fakeProvider(options) {
  let snap = null;
  const worker = {
    options,
    opens: 0,
    updates: 0,
    close: vi.fn(async () => {}),
    open: vi.fn(async ({ fen, multipv }) => { worker.opens += 1; snap = { session_id: "s", fen, multipv, pvs: [], current_depth: 0, max_depth: options.maxDepth, running: true }; }),
    update: vi.fn(async ({ fen, multipv }) => { worker.updates += 1; snap = { session_id: "s", fen, multipv, pvs: [], current_depth: 0, max_depth: options.maxDepth, running: true }; }),
    snapshot: () => snap,
    progress: (depth) => { snap = { ...snap, current_depth: depth, pvs: Array.from({ length: snap.multipv }, (_, i) => ({ score_cp: 20 - i, mate_in: null, pv_uci: ["a1a2"], pv_san: ["Ka2"] })) }; },
    finish: (depth = options.maxDepth) => { worker.progress(depth); snap = { ...snap, running: false }; },
    fail: (message = "worker died") => { snap = { ...snap, error: message, running: false }; },
    get fen() { return snap && snap.fen; },
  };
  workers.push(worker);
  return worker;
}
const laneFor = (fen) => workers.find((w) => w.fen === fen && w.snapshot().running);

beforeEach(() => {
  vi.useFakeTimers();
  workers = [];
  store = createPositionAnalysisStore({ createProvider: fakeProvider, lanes: 2, pollMs: 50, idleCloseMs: 1000 });
});
afterEach(() => { store.clear(); vi.useRealTimers(); });

describe("position identity", () => {
  it("ignores fullmove numbers but preserves the draw clock", () => {
    expect(positionKey(A.replace("0 1", "0 40"))).toBe(positionKey(A));
    expect(positionKey(A.replace("0 1", "12 40"))).not.toBe(positionKey(A));
    expect(positionKey(B)).not.toBe(positionKey(A));
  });
});

describe("interactive lanes", () => {
  it("answers terminal positions without a worker or polling timer", async () => {
    const lease = store.acquire("7k/6Q1/5K2/8/8/8/8/8 b - - 0 1", { multipv: 2 });
    expect(lease.satisfied()).toBe(true);
    await expect(lease.until()).resolves.toMatchObject({ running: false, pvs: [] });
    lease.release();
    expect(workers).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands an abandoned lane to a queued position immediately on release", async () => {
    const a = store.acquire(A);
    const b = store.acquire(B);
    await vi.advanceTimersByTimeAsync(0);
    const c = store.acquire(C);
    a.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(laneFor(C)).toBeTruthy();
    expect(laneFor(B)).toBeTruthy();
    b.release();
    c.release();
  });

  it("resolves a failed search even when an earlier partial evaluation exists", async () => {
    const lease = store.acquire(A, { multipv: 2 });
    await vi.advanceTimersByTimeAsync(0);
    workers[0].progress(8);
    await vi.advanceTimersByTimeAsync(60);
    const answered = vi.fn();
    lease.until().then(answered);
    workers[0].fail();
    await vi.advanceTimersByTimeAsync(60);
    expect(answered).toHaveBeenCalledWith(expect.objectContaining({ error: "worker died" }));
    lease.release();
  });

  it("clearing the store settles outstanding leases and removes timers", async () => {
    const lease = store.acquire(A);
    await vi.advanceTimersByTimeAsync(0);
    const answered = vi.fn();
    lease.until().then(answered);
    store.clear();
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toHaveBeenCalledWith(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Coach and Engine on the same position share one search; releasing one keeps the other", async () => {
    const coach = store.acquire(A, { depth: 16, multipv: 2 });
    const engine = store.acquire(A, { depth: 16, multipv: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(1);
    engine.release();
    workers[0].finish(16);
    await vi.advanceTimersByTimeAsync(60);
    expect(coach.snapshot()).toMatchObject({ current_depth: 16, running: false });
    expect(coach.snapshot().pvs).toHaveLength(2);
    expect(workers[0].close).not.toHaveBeenCalled();
  });

  it("stepping through many positions reuses warm workers instead of booting one per ply", async () => {
    const handle = store.createHandle({ maxDepth: 16 });
    const fens = [A, B, C];
    for (let i = 0; i < 30; i += 1) {
      const fen = fens[i % fens.length];
      await handle.update({ fen, multipv: 2 });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(workers.length).toBeLessThanOrEqual(2);
    const switches = workers.reduce((n, w) => n + w.opens + w.updates, 0);
    expect(switches).toBeGreaterThan(2);
  });

  it("the newest position gets a lane first, and a held search is never preempted", async () => {
    const held = store.acquire(A, { depth: 16, multipv: 1 });
    const old = store.acquire(B, { depth: 16, multipv: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    old.release(); // B is still searching but nobody needs it
    const latest = store.acquire(C, { depth: 16, multipv: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(laneFor(C)).toBeTruthy();
    expect(laneFor(A)).toBeTruthy();
    expect(held.snapshot().running).toBe(true);
    latest.release();
    held.release();
  });

  it("a quick A → B → A return finds A's interrupted depth instead of starting from zero", async () => {
    const handle = store.createHandle({ maxDepth: 16 });
    await handle.open({ fen: A, multipv: 1 });
    await vi.advanceTimersByTimeAsync(0);
    workers[0].progress(12);
    await vi.advanceTimersByTimeAsync(60);
    await handle.update({ fen: B, multipv: 1 });
    // Both lanes busy so B's request takes the abandoned A lane only when needed.
    const other = store.acquire(C, { depth: 16, multipv: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await handle.update({ fen: A, multipv: 1 });
    expect(handle.snapshot().current_depth).toBeGreaterThanOrEqual(12);
    expect(handle.snapshot().pvs.length).toBe(1);
    other.release();
  });

  it("a MultiPV upgrade restarts the same lane rather than serving fewer lines", async () => {
    const one = store.acquire(A, { depth: 16, multipv: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const two = store.acquire(A, { depth: 16, multipv: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(1);
    expect(workers[0].snapshot().multipv).toBe(3);
    workers[0].finish(16);
    await vi.advanceTimersByTimeAsync(60);
    expect(two.snapshot().pvs).toHaveLength(3);
    expect(one.snapshot().pvs.length).toBeGreaterThanOrEqual(1);
  });

  it("a dead worker resolves waiters with the error and the next request retries on a fresh worker", async () => {
    const lease = store.acquire(A, { depth: 16, multipv: 2 });
    await vi.advanceTimersByTimeAsync(0);
    const waiting = lease.until();
    workers[0].fail("Browser Stockfish failed to start");
    await vi.advanceTimersByTimeAsync(60);
    await expect(waiting).resolves.toMatchObject({ error: "Browser Stockfish failed to start" });
    lease.release();
    const retry = store.acquire(A, { depth: 16, multipv: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    workers[1].finish(16);
    await vi.advanceTimersByTimeAsync(60);
    expect(retry.snapshot()).toMatchObject({ current_depth: 16 });
    expect(retry.snapshot().error).toBeUndefined();
  });

  it("a released lease's waiter resolves null instead of hanging", async () => {
    const lease = store.acquire(A, { depth: 16, multipv: 2 });
    const waiting = lease.until();
    lease.release();
    await expect(waiting).resolves.toBeNull();
  });

  it("idle warm workers are closed after the idle window", async () => {
    const lease = store.acquire(A, { depth: 16 });
    await vi.advanceTimersByTimeAsync(0);
    workers[0].finish();
    await vi.advanceTimersByTimeAsync(60);
    lease.release();
    await vi.advanceTimersByTimeAsync(1100);
    expect(workers[0].close).toHaveBeenCalledOnce();
  });
});

describe("game channel", () => {
  it("publishes the provider's SAN without converting the whole-game PV again", async () => {
    const sanLine = vi.fn(() => ["converted"]);
    const s = createPositionAnalysisStore({ sanLine, analyzeFn: (opts) => analyzeGamePositions({
      ...opts,
      createProvider: (options) => {
        const worker = fakeProvider(options);
        const open = worker.open;
        worker.open = async (request) => { await open(request); worker.finish(); };
        return worker;
      },
    }) });
    await s.analyzeGame({ positions: [A], depth: 16 });
    const lease = s.acquire(A, { depth: 16 });
    expect(lease.snapshot().pvs[0].pv_san).toEqual(["Ka2"]);
    expect(sanLine).not.toHaveBeenCalled();
    lease.release();
    s.clear();
  });

  it("does not reuse an advantage after the fifty-move draw clock expires", async () => {
    store.clear();
    store = createPositionAnalysisStore({ analyzeFn: (opts) => analyzeGamePositions({ ...opts, createProvider: fakeProvider }) });
    const fen = "7k/8/8/8/8/8/R7/K7 w - - 0 1";
    store.publishGame(fen, { score_cp: 500, mate_in: null, pv: ["a2h2"], depth: 16 }, 16);
    const drawn = fen.replace("0 1", "100 51");
    const evals = await store.analyzeGame({ positions: [drawn], depth: 16 });
    expect(evals.get(drawn).score_cp).toBe(0);
  });

  it("a published whole-game eval answers a single-line consumer without a search", async () => {
    store.publishGame(A, { score_cp: 35, mate_in: null, pv: ["a1a2"], depth: 16 }, 16);
    const lease = store.acquire(A, { depth: 16, multipv: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(0);
    expect(lease.snapshot()).toMatchObject({ running: false, current_depth: 16, pvs: [{ score_cp: 35 }] });
  });

  it("a UCI-only game-pass result is published with SAN so the Coach never names a move in UCI", async () => {
    const s = createPositionAnalysisStore({ createProvider: fakeProvider, sanLine: (fen, line) => line.map((u) => `san(${u})`) });
    s.publishGame(A, { score_cp: 35, mate_in: null, pv: ["g8f6", "e4e5"], depth: 16 }, 16);
    const lease = s.acquire(A, { depth: 16, multipv: 1 });
    expect(lease.snapshot().pvs[0].pv_san).toEqual(["san(g8f6)", "san(e4e5)"]);
    lease.release();
    s.clear();
  });

  it("a saved analysis' eval answers a single-line consumer without booting a worker", async () => {
    const savedEval = vi.fn((fen) => (fen === A ? { score_cp: -40, mate_in: null, pv: ["a1b1"], depth: 18 } : null));
    const s = createPositionAnalysisStore({ createProvider: fakeProvider, savedEval });
    const lease = s.acquire(A, { depth: 16, multipv: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(0);
    expect(lease.snapshot()).toMatchObject({ running: false, current_depth: 18, pvs: [{ score_cp: -40 }] });
    lease.release();
    s.clear();
  });

  it("keeps the game eval separate from a deeper MultiPV live read", async () => {
    store.publishGame(A, { score_cp: 35, mate_in: null, pv: ["a1a2"], depth: 16 }, 16);
    const lease = store.acquire(A, { depth: 16, multipv: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(1);
    // Until the live search has lines, the game eval is the partial view.
    expect(lease.snapshot().pvs[0].score_cp).toBe(35);
    workers[0].finish(16);
    await vi.advanceTimersByTimeAsync(60);
    expect(lease.snapshot().pvs).toHaveLength(2);
    expect(store.reusableGameEval(A, 16).score_cp).toBe(35);
  });

  it("the whole-game pass reuses finished reads and publishes each result as it lands", async () => {
    const lease = store.acquire(A, { depth: 16, multipv: 2 });
    await vi.advanceTimersByTimeAsync(0);
    workers[0].finish(16);
    await vi.advanceTimersByTimeAsync(60);
    lease.release();
    const analyzeFn = vi.fn(async ({ positions, reuse, onResult }) => {
      const out = new Map();
      for (const fen of positions) {
        const ev = reuse(fen) || { score_cp: 1, mate_in: null, pv: [], depth: 16 };
        onResult(fen, ev);
        out.set(fen, ev);
      }
      return out;
    });
    const s2 = createPositionAnalysisStore({ createProvider: fakeProvider, analyzeFn });
    const results = [];
    // Seed s2 with a live result the way a Coach read would.
    const seed = s2.acquire(B, { depth: 16, multipv: 1 });
    await vi.advanceTimersByTimeAsync(0);
    workers.at(-1).finish(16);
    await vi.advanceTimersByTimeAsync(150);
    seed.release();
    const evals = await s2.analyzeGame({ positions: [A, B], depth: 16, onResult: (fen) => results.push(fen) });
    expect(evals.get(B).score_cp).toBe(20); // reused from the live read, not searched
    expect(results).toEqual([A, B]);
    const after = s2.acquire(A, { depth: 16, multipv: 1 });
    expect(after.snapshot().pvs[0].score_cp).toBe(1);
    after.release();
    s2.clear();
  });
});

describe("maia channel", () => {
  beforeEach(() => vi.useRealTimers());
  it("coalesces reads in one tick into one batched forward and caches per rating", async () => {
    const provider = {
      positionRead: vi.fn(async ({ fen }) => ({ fen })),
      batch: vi.fn(async (type, { fens }) => fens.map((fen) => ({ fen, batched: true }))),
    };
    const s = createPositionAnalysisStore({ createProvider: fakeProvider, getMaia: () => provider });
    const reads = await Promise.all([s.maiaRead(A, 1500), s.maiaRead(B, 1500), s.maiaRead(A, 1500)]);
    expect(provider.batch).toHaveBeenCalledOnce();
    expect(provider.batch.mock.calls[0][0]).toBe("positionReadBatch");
    expect(provider.batch.mock.calls[0][1].fens).toEqual([A, B]);
    expect(reads.map((r) => r.batched)).toEqual([true, true, true]);
    await s.maiaRead(A, 1500);
    expect(provider.batch).toHaveBeenCalledOnce();
    await s.maiaRead(A, 1900);
    expect(provider.positionRead).toHaveBeenCalledOnce();
    s.clear();
  });

  it("a failed Maia read is retried on the next request", async () => {
    let fail = true;
    const provider = { positionRead: vi.fn(async () => { if (fail) throw new Error("boom"); return { ok: true }; }) };
    const s = createPositionAnalysisStore({ createProvider: fakeProvider, getMaia: () => provider });
    await expect(s.maiaRead(A, 1500)).rejects.toThrow("boom");
    fail = false;
    await expect(s.maiaRead(A, 1500)).resolves.toEqual({ ok: true });
    s.clear();
  });

  it("rejects pending reads if Maia is disabled before the batch flush", async () => {
    vi.useFakeTimers();
    let provider = { positionRead: vi.fn(async () => ({ ok: true })) };
    const s = createPositionAnalysisStore({ getMaia: () => provider });
    const read = s.maiaRead(A, 1500);
    const rejected = expect(read).rejects.toThrow("Maia unavailable");
    provider = null;
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    s.clear();
  });

  it("clearing the store rejects queued Maia reads without starting inference", async () => {
    vi.useFakeTimers();
    const provider = { positionRead: vi.fn(async () => ({ ok: true })) };
    const s = createPositionAnalysisStore({ getMaia: () => provider });
    const read = s.maiaRead(A, 1500);
    const rejected = expect(read).rejects.toThrow("Analysis store cleared");
    s.clear();
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(provider.positionRead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
