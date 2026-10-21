import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { createPositionAnalysisStore, positionKey } from "./position-analysis-store.js";
import { analyzeGamePositions } from "./game-analyzer.js";
import { stockfishBudget } from "./compute-budget.js";
import { createStockfishWasmProvider } from "./stockfish-provider.js";

const A = "8/8/8/8/8/8/R7/K6k w - - 0 1";
const B = "8/8/8/8/8/8/R7/K6k b - - 0 1";
const C = "8/8/8/8/8/8/RK5k/8 w - - 0 1";

// A real game's positions, for the tests that step for real: a step lands on a
// position nothing has searched, which is the case that boots a worker.
const GAME_MOVES =
  "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 " +
  "c4 c6 cxb5 axb5 Nc3 Bb7 Bg5 b4 Nb1 h6 Bh4 c5 dxe5 Nxe4 Bxe7 Qxe7 exd6 Qf6 " +
  "Nbd2 Nxd6 Nc4 Nxc4 Bxc4 Nb6 Ne5 Rae8 Bxf7+ Rxf7 Nxf7 Rxe1+ Qxe1 Kxf7";
const GAME_PLIES = (() => {
  const chess = new Chess();
  return GAME_MOVES.split(/\s+/).filter((t) => !/^\d+\.$/.test(t)).map((san) => {
    chess.move(san);
    return chess.fen();
  });
})();

// A Worker stand-in for the real provider: answers the handshake, reports one depth,
// and concludes a `stop` with `bestmove` the way a real engine does (the provider's
// drain waits for that line before it launches the next search).
class FakeEngineWorker {
  constructor() { this.posted = []; this.onmessage = null; this.terminated = false; this.searching = false; this.depth = 16; }
  postMessage(msg) {
    if (this.terminated) return;
    this.posted.push(msg);
    if (msg === "isready") queueMicrotask(() => this.emit("readyok"));
    if (typeof msg === "string" && msg.startsWith("go ")) {
      this.depth = Number((msg.match(/depth (\d+)/) || [])[1] || 16);
      this.searching = true;
    }
    if (msg === "stop" && this.searching) {
      this.searching = false;
      queueMicrotask(() => this.emit("bestmove e2e4"));
    }
  }
  emit(line) { if (!this.terminated) this.onmessage?.({ data: line }); }
  // The engine reaches its target depth and stops on its own.
  finish() {
    if (this.terminated || !this.searching) return;
    this.searching = false;
    this.emit(`info depth ${this.depth} score cp 20 pv e2e4 e7e5`);
    this.emit("bestmove e2e4");
  }
  terminate() { this.terminated = true; }
}

// Providers shaped exactly like the live one: a Stockfish WASM provider that takes a
// slot from the page-wide engine budget for the whole life of its worker and gives it
// back on close. A fake provider that never allocates never queues, so the budget's
// reclaim path — the thing that reboots a worker per ply on a one-engine phone — would
// never run and the test would pass while the app still OOMs.
const realShapedProvider = (created) => (options) => createStockfishWasmProvider({
  ...options,
  computeBudget: stockfishBudget,
  profileManaged: false,
  loadModule: async () => ({}),
  reserveMemory: () => ({}),
  createWorker: () => {
    const worker = new FakeEngineWorker();
    created.push(worker);
    return worker;
  },
});

let store;
let workers;
// A fake EngineProvider: one "worker" per provider, switching positions with update.
function fakeProvider(options) {
  let snap = null;
  const worker = {
    options,
    // The real provider pushes every depth it reaches; the store captures on it.
    watch(fn) { worker.onChange = fn || null; },
    opens: 0,
    updates: 0,
    close: vi.fn(async () => {}),
    open: vi.fn(async ({ fen, multipv }) => { worker.opens += 1; snap = { session_id: "s", fen, multipv, pvs: [], current_depth: 0, max_depth: options.maxDepth, running: true }; }),
    update: vi.fn(async ({ fen, multipv }) => { worker.updates += 1; snap = { session_id: "s", fen, multipv, pvs: [], current_depth: 0, max_depth: options.maxDepth, running: true }; }),
    snapshot: () => snap,
    progress: (depth) => {
      snap = { ...snap, current_depth: depth, pvs: Array.from({ length: snap.multipv }, (_, i) => ({ score_cp: 20 - i, mate_in: null, pv_uci: ["a1a2"], pv_san: ["Ka2"] })) };
      worker.onChange?.();
    },
    finish: (depth = options.maxDepth) => { worker.progress(depth); snap = { ...snap, running: false }; worker.onChange?.(); },
    fail: (message = "worker died") => { snap = { ...snap, error: message, running: false }; worker.onChange?.(); },
    get fen() { return snap && snap.fen; },
  };
  workers.push(worker);
  return worker;
}
const laneFor = (fen) => workers.find((w) => w.fen === fen && w.snapshot().running);

// The store's lanes follow the page-wide engine budget, which engine-profile.js
// configures from the device's usable profile. Tests state the device by configuring
// that budget, exactly as a Detect or a Settings pick does.
const deviceWithEngines = (workers) => stockfishBudget.configure(workers);

beforeEach(() => {
  vi.useFakeTimers();
  workers = [];
  deviceWithEngines(2);
  store = createPositionAnalysisStore({ createProvider: fakeProvider, idleCloseMs: 1000 });
});
afterEach(() => {
  store.clear();
  deviceWithEngines(1);
  vi.useRealTimers();
});

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

  it("the handle pushes every depth the search reaches instead of being polled", async () => {
    const seen = [];
    const handle = store.createHandle({ maxDepth: 16 });
    handle.watch((snap) => seen.push(snap.current_depth));
    await handle.open({ fen: A, multipv: 1 });
    await vi.advanceTimersByTimeAsync(0);
    for (const depth of [2, 4, 6]) {
      workers[0].progress(depth);
      await vi.advanceTimersByTimeAsync(0);
    }
    // Every depth the engine reported reached the consumer — no timer sampled them away.
    expect(seen).toEqual([2, 4, 6]);
    // Detaching stops the pushes.
    handle.watch(null);
    workers[0].progress(8);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([2, 4, 6]);
    expect(vi.getTimerCount()).toBe(0); // no polling interval anywhere
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

  it("leaving the view frees a warm worker now instead of after the idle window", async () => {
    // The store is a page-wide singleton, so an idle lane outlives the view that used
    // it: its whole reserved heap sat for `idleCloseMs` (60 s live) with nothing left
    // to answer. `releaseWarm` is what the view switch calls on the way out.
    const lease = store.acquire(A, { depth: 16 });
    await vi.advanceTimersByTimeAsync(0);
    workers[0].finish();
    await vi.advanceTimersByTimeAsync(60);
    lease.release();
    // Idle, and inside the idle window: the worker is still warm.
    expect(workers[0].close).not.toHaveBeenCalled();
    store.releaseWarm();
    expect(workers[0].close).toHaveBeenCalledOnce();
    // The finished read is cached, so coming back answers from it; a position the
    // store has no read for boots a NEW worker rather than reviving the closed one.
    const again = store.acquire(B, { depth: 16 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    expect(workers[1].close).not.toHaveBeenCalled();
    again.release();
  });

  it("a search someone still holds keeps its worker when warm workers are freed", async () => {
    // Only IDLE workers are freed: a lane mid-search is answering a lease, and
    // dropping it would turn a busy position into an error for its reader.
    const lease = store.acquire(A, { depth: 16 });
    await vi.advanceTimersByTimeAsync(0);
    store.releaseWarm();
    expect(workers[0].close).not.toHaveBeenCalled();
    expect(lease.snapshot().running).toBe(true);
    lease.release();
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

  it("the whole-game pass reuses finished reads and publishes each result as it lands", async () => {    const lease = store.acquire(A, { depth: 16, multipv: 2 });
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

  it("a running pass reads back what it has saved, and says nothing for a position it has not reached", async () => {
    // A two-position pass the test controls: the first result lands, then the
    // probe reads both positions while the pass is still running.
    let release;
    const atGate = new Promise((resolve) => { release = resolve; });
    const s = createPositionAnalysisStore({ createProvider: fakeProvider, analyzeFn: async ({ positions, onResult }) => {
      onResult(positions[0], { score_cp: 21, mate_in: null, pv: ["a1a2"], depth: 18 });
      await atGate;
      return new Map();
    } });
    const pass = s.analyzeGame({ positions: [A, B], depth: 18 });
    expect(s.passing).toBe(true);
    // The saved position reads back as the pass's own result, at its real depth.
    expect(s.passRead(A)).toMatchObject({ source: "analysis", running: false, current_depth: 18, pvs: [{ score_cp: 21 }] });
    // The one it has not reached has nothing — not an empty search, no worker.
    expect(s.passRead(B)).toBeNull();
    release();
    await pass;
    expect(s.passing).toBe(false);
    expect(workers).toHaveLength(0);
    s.clear();
  });

  it("a MultiPV follow-up read is not a pass: the card keeps its worker", async () => {
    const s = createPositionAnalysisStore({
      createProvider: fakeProvider,
      analyzeFn: async ({ onResult }) => { onResult(A, { score_cp: 5, mate_in: null, pv: ["a1a2"], depth: 16 }); return new Map(); },
    });
    const seen = [];
    s.onPassChange(() => seen.push(s.passing));
    // The brilliant check's best-other-move read runs on the same pool but is not
    // a full-game pass: it must not send the card to the game channel.
    await s.analyzeGame({ positions: [A], depth: 16, multipv: 3 });
    expect(s.passing).toBe(false);
    expect(seen).toEqual([]);
    // The game channel stays single-line: a MultiPV read publishes nothing.
    expect(s.passRead(A)).toBeNull();
    s.clear();
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

// A phone runs one engine; every lane reserves a whole WASM heap, and a lane past the
// budget makes the budget reclaim a warm worker on each step — a fresh heap per ply.
// The lane count is internal (read from the engine budget), so these tests state the
// DEVICE by configuring that budget — as a Detect or a Settings pick does — and then
// count the Workers the store actually boots.
describe("interactive lanes follow the device's engine budget", () => {
  it("steps 40 plies quickly on a one-engine phone without booting a worker per ply", async () => {
    deviceWithEngines(1);
    const created = [];
    const s = createPositionAnalysisStore({ createProvider: realShapedProvider(created) });
    // Two consumers on two DIFFERENT positions, which is what a fast step produces:
    // the Engine card holds the board's position, and the Coach asks for the position
    // BEFORE the move (its "best alternative" read) for the same ply. One lane cannot
    // serve both, so if a second lane existed it would register as idle, the budget
    // would reclaim the warm lane's worker to give it one, and the next ply would boot
    // another — a fresh whole-heap reservation per ply, which is what OOMs a phone.
    const card = s.createHandle({ maxDepth: 16 });
    let coach = null;
    for (let i = 0; i < 40; i += 1) {
      const step = card.update({ fen: GAME_PLIES[i], multipv: 1 });
      await vi.advanceTimersByTimeAsync(2);
      coach?.release();
      coach = s.acquire(GAME_PLIES[Math.max(0, i - 1)], { depth: 16, multipv: 2 });
      await vi.advanceTimersByTimeAsync(3);
      for (const worker of created) worker.finish();
      await vi.advanceTimersByTimeAsync(3);
      await step;
    }
    coach?.release();
    await card.close();
    s.clear();
    // One engine on this device: 40 plies must not boot a worker per ply. Measured
    // with a fixed two lanes instead of the budget's one: 39 workers for these steps.
    expect(created).toHaveLength(1);
    expect(stockfishBudget.snapshot().used).toBe(0);
  });

  it("runs one engine per lane on a three-engine device, never more", async () => {
    deviceWithEngines(3);
    const created = [];
    const s = createPositionAnalysisStore({ createProvider: realShapedProvider(created) });
    const leases = [0, 6, 12].map((i) => s.acquire(GAME_PLIES[i], { depth: 16, multipv: 1 }));
    await vi.advanceTimersByTimeAsync(10);
    // Three readers on three positions: three engines, the whole device budget.
    expect(created).toHaveLength(3);
    for (const worker of created) worker.finish();
    await vi.advanceTimersByTimeAsync(10);
    for (const lease of leases) lease.release();
    s.clear();
    expect(stockfishBudget.snapshot().used).toBe(0);
  });
});
