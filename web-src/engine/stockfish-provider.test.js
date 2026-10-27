import { describe, it, expect, vi } from "vitest";

import { createStockfishWasmProvider, engineIdentity, engineScriptUrl, STOCKFISH } from "./stockfish-provider.js";
import { setEngineProfile, resetEngineProfile, reportEngineFailure, guardEngineStartup,
  createEngineProfileManager, usableEngineProfile } from "./engine-profile.js";
import { EngineAssetError } from "./engine-assets.js";
import { createComputeBudget } from "./compute-budget.js";

vi.mock("./engine-profile.js", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, reserveEngineMemory: vi.fn(() => ({})),
    usableEngineProfile: vi.fn(actual.usableEngineProfile),
    guardEngineStartup: vi.fn(actual.guardEngineStartup),
    engineStarted: vi.fn(), reportEngineFailure: vi.fn(actual.reportEngineFailure) };
});
vi.mock("./engine-assets.js", async importOriginal => ({ ...await importOriginal(),
  loadEngineModule: vi.fn(async () => ({})),
}));

const FEN_A = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FEN_B = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const FEN_C = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";

// A controllable stand-in for the Stockfish Web Worker. It records everything posted to it
// and lets the test deliver UCI lines back on demand (engine output is asynchronous in real
// life, so the test drives the exact interleaving that triggers the stale-line bug). The
// handshake (`isready` → `readyok`) is auto-answered so open()/update() can resolve.
class FakeWorker {
  // `autoReady = false` models a worker still starting up: it never answers `isready`, so the
  // provider stays mid-handshake — the state needed to exercise close()-during-init.
  constructor({ autoReady = true } = {}) {
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    this.autoReady = autoReady;
  }
  postMessage(msg) {
    if (this.terminated) return;
    this.posted.push(msg);
    if (msg === "isready" && this.autoReady) this.emit("readyok");
  }
  // A terminated worker delivers no more messages — modelling the real Worker.terminate(), which
  // is what stops a torn-down (wedged) engine's late output from reaching handleLine.
  terminate() {
    this.terminated = true;
  }
  emit(line) {
    if (this.terminated) return;
    if (this.onmessage) this.onmessage({ data: line });
  }
}

function makeProvider() {
  const fake = new FakeWorker();
  const provider = createStockfishWasmProvider({ createWorker: () => fake });
  return { provider, fake };
}

// Let queued microtasks/timers drain so the provider's internal `await readyPromise` hop and
// the `stop` it posts settle before we assert on them.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("per-net provider identity", () => {
  it("starts lite at the user's depth while the recommended full asset is not ready", async () => {
    const data = new Map();
    const manager = createEngineProfileManager({ storage: () => ({ getItem: k => data.get(k) ?? null,
      setItem: (k, v) => data.set(k, v) }), assetState: () => ({ phase: "download" }),
    device: () => ({ hardwareConcurrency: 4, deviceMemory: 8 }) });
    manager.setEngineProfile({ net: "big", workers: 3 });
    expect(manager.engineProfile()).toMatchObject({ net: "big", workers: 3 });
    const originalUsable = usableEngineProfile.getMockImplementation();
    usableEngineProfile.mockImplementation(manager.usableEngineProfile);
    const worker = new FakeWorker(), loadModule = vi.fn(async () => ({}));
    const provider = createStockfishWasmProvider({ maxDepth: 23, loadModule, createWorker: () => worker });
    try {
      await provider.open({ fen: FEN_A });
      expect(loadModule).toHaveBeenCalledWith("lite");
      expect(provider.snapshot().engine).toBe(engineIdentity("lite"));
      expect(worker.posted).toContain("go depth 23");
    } finally { await provider.close(); usableEngineProfile.mockImplementation(originalUsable); }
  });
  it.each(["big", "lite"])("loads %s with its own URL and snapshot identity", async net => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const provider = createStockfishWasmProvider({ net, createWorker: factory });
    await provider.open({ fen: FEN_A });
    expect(factory).toHaveBeenCalledWith(`/static/engine/${STOCKFISH[net].dir}/stockfish.js`);
    expect(provider.snapshot().engine).toBe(`${STOCKFISH[net].id} t1 h16`);
    expect(engineScriptUrl(net)).toContain(STOCKFISH[net].dir);
    expect(engineIdentity("big")).not.toBe(engineIdentity("lite"));
    await provider.close();
  });
  it("keeps an active worker and its identity across a profile change", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A });
    const waiting = provider.waitForSearchComplete({ targetDepth: 16, timeoutMs: 1000 });
    const identity = provider.snapshot().engine;
    setEngineProfile({ net: "big", workers: 2 });
    fake.emit("info depth 16 score cp 20 pv e2e4");
    await waiting;
    expect(provider.snapshot().engine).toBe(identity);
    expect(fake.terminated).toBe(false);
    await provider.close();
    resetEngineProfile();
  });
});

describe("provider compute allocation lifecycle", () => {
  it("reserves before creating a worker and posts the same Memory before UCI without a transfer list", async () => {
    const memory = {}, wasmModule = {};
    const worker = new FakeWorker();
    const post = vi.spyOn(worker, "postMessage");
    const events = [];
    const reserveMemory = vi.fn(net => { events.push("reserve"); expect(net).toBe("big"); return memory; });
    const loadModule = vi.fn(async () => { events.push("module"); return wasmModule; });
    const provider = createStockfishWasmProvider({ net: "big", reserveMemory, loadModule,
      createWorker: () => { events.push("worker"); return worker; } });
    await provider.prepare();
    expect(events).toEqual(["module", "reserve", "worker"]);
    expect(post.mock.calls[0]).toEqual([{ wasmModule, wasmMemory: memory }]);
    expect(worker.posted[1]).toBe("uci");
    await provider.close();
  });

  it("injects a probe reservation without allocating a second heap", async () => {
    const memory = {}, wasmModule = {}, worker = new FakeWorker(), reserveMemory = vi.fn(), loadModule = vi.fn();
    const provider = createStockfishWasmProvider({ wasmModule, wasmMemory: memory, loadModule, reserveMemory, createWorker: () => worker });
    await provider.prepare();
    expect(reserveMemory).not.toHaveBeenCalled();
    expect(loadModule).not.toHaveBeenCalled();
    expect(worker.posted[0].wasmModule).toBe(wasmModule);
    expect(worker.posted[0].wasmMemory).toBe(memory);
    await provider.close();
  });

  it("waits beyond the startup deadline for assets with no heap, crash guard or timer", async () => {
    vi.useFakeTimers();
    const create = vi.fn();
    vi.stubGlobal("Worker", class extends FakeWorker { constructor() { super(); create(); } });
    guardEngineStartup.mockClear();
    let resolveModule;
    const pendingModule = new Promise(resolve => { resolveModule = resolve; });
    const reserveMemory = vi.fn(() => ({}));
    const provider = createStockfishWasmProvider({ computeBudget: null, reserveMemory, loadModule: () => pendingModule });
    try {
      const ready = provider.prepare();
      await vi.advanceTimersByTimeAsync(120000);
      expect(create).not.toHaveBeenCalled();
      expect(reserveMemory).not.toHaveBeenCalled();
      expect(guardEngineStartup).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      resolveModule({});
      await ready;
      expect(reserveMemory).toHaveBeenCalledTimes(1);
      expect(guardEngineStartup).toHaveBeenCalledTimes(1);
    } finally { await provider.close(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  });

  it.each([new Error("download aborted"), new RangeError("compile out of memory")])(
    "does not step down the profile for asset failure: %s", async cause => {
      vi.stubGlobal("Worker", vi.fn());
      guardEngineStartup.mockClear(); reportEngineFailure.mockClear();
      const reserveMemory = vi.fn();
      const provider = createStockfishWasmProvider({ computeBudget: null, reserveMemory,
        loadModule: async () => { throw cause; } });
      try {
        await expect(provider.prepare()).rejects.toBeInstanceOf(EngineAssetError);
        expect(reserveMemory).not.toHaveBeenCalled();
        expect(guardEngineStartup).not.toHaveBeenCalled();
        expect(reportEngineFailure).not.toHaveBeenCalled();
        expect(provider.snapshot().error).toContain(cause.message);
      } finally { await provider.close(); vi.unstubAllGlobals(); }
    });

  it("does not resurrect a closed provider when its shared module becomes ready", async () => {
    let resolveModule;
    const module = new Promise(resolve => { resolveModule = resolve; });
    const createWorker = vi.fn(() => new FakeWorker()), reserveMemory = vi.fn(() => ({}));
    const provider = createStockfishWasmProvider({ createWorker, reserveMemory, loadModule: () => module });
    const pending = provider.prepare().catch(error => error);
    await tick();
    await provider.close();
    resolveModule({});
    expect((await pending).message).toMatch(/closed/);
    expect(createWorker).not.toHaveBeenCalled();
    expect(reserveMemory).not.toHaveBeenCalled();
    await provider.prepare();
    expect(createWorker).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  it("surfaces reservation failure without creating a worker and releases the compute slot", async () => {
    const budget = createComputeBudget({ limit: 1, backgroundLimit: 1 });
    const createWorker = vi.fn();
    const provider = createStockfishWasmProvider({ createWorker, computeBudget: budget,
      reserveMemory: () => { throw new RangeError("address space gone"); } });
    await expect(provider.prepare()).rejects.toThrow(/could not start: address space gone/);
    expect(createWorker).not.toHaveBeenCalled();
    expect(budget.snapshot().used).toBe(0);
    await provider.close();
  });

  it("keeps the crash mark while the worker holds its heap, reports a live failure, then rebuilds", async () => {
    const workers = [];
    vi.stubGlobal("Worker", class extends FakeWorker { constructor() { super(); workers.push(this); } });
    guardEngineStartup.mockClear();
    const provider = createStockfishWasmProvider({ computeBudget: null });
    try {
      await provider.open({ fen: FEN_A });
      workers[0].emit("info depth 18 score cp 20 pv e2e4");
      // Past its first search the worker still holds its heap: its crash mark stays armed.
      const [done, fail] = ["done", "fail"].map(k => vi.spyOn(guardEngineStartup.mock.results[0].value, k));
      workers[0].emit("bestmove e2e4");
      workers[0].emit("Aborted(OOM)");
      expect([done.mock.calls.length, fail.mock.calls.length, workers[0].terminated]).toEqual([0, 1, true]);
      await provider.open({ fen: FEN_B });
      expect(workers).toHaveLength(2);
      expect(provider.snapshot()).toMatchObject({ fen: FEN_B, error: null });
    } finally { await provider.close(); vi.unstubAllGlobals(); }
  });

  it("closing a queued provider settles its open without creating a worker", async () => {
    const budget = createComputeBudget({ limit: 1, backgroundLimit: 1 });
    const release = await budget.acquire();
    const factory = vi.fn(() => new FakeWorker());
    const provider = createStockfishWasmProvider({ createWorker: factory, computeBudget: budget });
    const pending = provider.open({ fen: FEN_A }).catch((error) => error);
    await tick();
    expect(budget.snapshot().queued).toBe(1);
    await provider.close();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(factory).not.toHaveBeenCalled();
    expect(budget.snapshot().queued).toBe(0);
    release();
    await provider.open({ fen: FEN_A });
    expect(factory).toHaveBeenCalledTimes(1);
    await provider.close();
    expect(budget.snapshot().used).toBe(0);
  });

  it("factory failures and worker crashes free their lifetime leases", async () => {
    const budget = createComputeBudget({ limit: 1, backgroundLimit: 1 });
    const fake = new FakeWorker();
    const factory = vi.fn().mockImplementationOnce(() => { throw new Error("startup failure"); })
      .mockImplementation(() => fake);
    const provider = createStockfishWasmProvider({ createWorker: factory, computeBudget: budget });
    await expect(provider.open({ fen: FEN_A })).rejects.toThrow("startup failure");
    expect(budget.snapshot().used).toBe(0);
    await provider.open({ fen: FEN_A });
    expect(budget.snapshot().used).toBe(1);
    fake.onerror({ message: "crashed" });
    expect(fake.terminated).toBe(true);
    expect(budget.snapshot().used).toBe(0);
    await provider.close();
    expect(budget.snapshot().used).toBe(0);
  });

  it("unrelated providers share a four-worker ceiling with an interactive reserve", async () => {
    const budget = createComputeBudget();
    const providers = Array.from({ length: 5 }, (_, i) => createStockfishWasmProvider({
      createWorker: () => new FakeWorker(), computeBudget: budget,
      priority: i === 4 ? "interactive" : "background",
    }));
    await Promise.all(providers.slice(0, 3).map((provider) => provider.open({ fen: FEN_A })));
    const waiting = providers[3].open({ fen: FEN_A });
    await providers[4].open({ fen: FEN_A });
    expect(budget.snapshot()).toMatchObject({ used: 4, background: 3, queued: 1 });
    await providers[0].close();
    await waiting;
    expect(budget.snapshot().used).toBe(4);
    await Promise.all(providers.map((provider) => provider.close()));
    expect(budget.snapshot()).toMatchObject({ used: 0, queued: 0 });
  });
});

describe("createStockfishWasmProvider — search lifecycle", () => {
  it("parses an info line into a White-POV pv", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 1 });
    fake.emit("info depth 20 score cp 35 pv e2e4 e7e5");
    const snap = provider.snapshot();
    expect(snap.fen).toBe(FEN_A);
    expect(snap.current_depth).toBe(20);
    expect(snap.pvs[0].score_cp).toBe(35);
    expect(snap.pvs[0].pv_uci).toEqual(["e2e4", "e7e5"]);
  });

  it("tells its watcher about every depth it reaches, not just the last one", async () => {
    const { provider, fake } = makeProvider();
    const depths = [];
    provider.watch(() => depths.push(provider.snapshot().current_depth));
    await provider.open({ fen: FEN_A, multipv: 1 });
    fake.emit("info depth 3 score cp 10 pv e2e4");
    fake.emit("info depth 4 score cp 12 pv e2e4");
    fake.emit("info depth 5 score cp 14 pv e2e4");
    fake.emit("bestmove e2e4");
    // Each depth wakes the consumer as it arrives, so a panel can deepen its rows in place.
    expect(depths).toEqual([3, 4, 5, 5]);
    provider.watch(null);
    fake.emit("info depth 6 score cp 16 pv e2e4");
    expect(depths).toEqual([3, 4, 5, 5]);
  });

  it("restricts the root moves with searchmoves when given candidates", async () => {    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 3, searchmoves: ["e2e4", "d2d4", "bogus", "g1f3"] });
    expect(fake.posted).toContain("setoption name MultiPV value 3");
    expect(fake.posted).toContain("go depth 18 searchmoves e2e4 d2d4 g1f3");
    fake.emit("bestmove e2e4");
    await provider.update({ fen: FEN_B, multipv: 1 });
    expect(fake.posted[fake.posted.length - 1]).toBe("go depth 18");
  });

  it("adds a node budget to the depth limit when maxNodes is set", async () => {
    const fake = new FakeWorker();
    const provider = createStockfishWasmProvider({
      maxDepth: 16,
      maxNodes: 1500000,
      createWorker: () => fake,
    });
    await provider.open({ fen: FEN_A, multipv: 1 });
    expect(fake.posted[fake.posted.length - 1]).toBe("go depth 16 nodes 1500000");
  });

  it("lets one search ask for its own depth without changing the provider's", async () => {
    const fake = new FakeWorker();
    const provider = createStockfishWasmProvider({ maxDepth: 16, createWorker: () => fake });
    await provider.open({ fen: FEN_A, multipv: 1, depth: 10 });
    expect(fake.posted[fake.posted.length - 1]).toBe("go depth 10");
    expect(provider.snapshot().max_depth).toBe(10);
    fake.emit("info depth 10 multipv 1 score cp 20 nodes 900 pv e2e4");
    fake.emit("bestmove e2e4");
    await provider.update({ fen: FEN_A, multipv: 3 });
    expect(fake.posted[fake.posted.length - 1]).toBe("go depth 16");
  });

  // The Explorer eval worker parks its search while the next position's rows load.
  // That must actually HALT the in-flight search, but keep the worker warm — a
  // close() here would force a full wasm re-init on every row refresh.
  it("stopSearch halts a running search but keeps the worker alive", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 2, searchmoves: ["e2e4", "d2d4"] });
    expect(provider.snapshot().running).toBe(true);
    provider.stopSearch();
    // A real engine concludes a stopped search with `bestmove`; the provider only
    // clears `running` on that line (same contract the drain path relies on).
    await tick();
    expect(fake.posted).toContain("stop");
    fake.emit("bestmove e2e4");
    expect(provider.snapshot().running).toBe(false);
    expect(fake.terminated).toBe(false);
    // Still usable: a later update reuses the same warm worker.
    await provider.update({ fen: FEN_B, multipv: 1 });
    expect(fake.terminated).toBe(false);
    expect(fake.posted[fake.posted.length - 1]).toBe("go depth 18");
  });

  it("stopSearch is a no-op when no search is running", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 1 });
    fake.emit("bestmove e2e4");
    expect(provider.snapshot().running).toBe(false);
    const before = fake.posted.length;
    provider.stopSearch();
    await tick();
    expect(fake.posted.length).toBe(before);
    expect(fake.terminated).toBe(false);
  });

  it("drains the previous search so its late info/bestmove cannot pollute the next FEN (#6)", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 1 });

    // Search A reaches the target depth but is still running (the engine has not yet emitted
    // its bestmove) — exactly the state in which game-analyzer returns early via `reached`.
    fake.emit("info depth 99 score cp 50 pv e2e4");
    expect(provider.snapshot().running).toBe(true);

    // Switch to FEN B while A is still in flight. update() must not resolve until A is drained.
    let updated = false;
    const updatePromise = provider.update({ fen: FEN_B, multipv: 1 }).then(() => {
      updated = true;
    });
    await tick(); // let `await readyPromise` resolve so the drain posts its `stop`

    // A `stop` must have been posted to abort A.
    expect(fake.posted).toContain("stop");

    // A's trailing output now arrives DURING the drain — both must be ignored.
    fake.emit("info depth 99 score cp 9999 pv a2a3a4"); // stale pv from the abandoned search
    expect(updated).toBe(false); // still draining; update() has not resolved
    expect(provider.snapshot().fen).toBe(FEN_A); // new state not applied until drain ends

    // A's concluding bestmove ends the drain; only now does the new search launch.
    fake.emit("bestmove e2e4");
    await updatePromise;
    expect(updated).toBe(true);

    const snap = provider.snapshot();
    expect(snap.fen).toBe(FEN_B);
    expect(snap.pvs).toEqual([]); // the stale cp 9999 line did NOT leak in
    expect(snap.current_depth).toBe(0);
    expect(snap.running).toBe(true); // A's bestmove was the drain's, not B's → B still searching
  });

  it("a stale bestmove cannot flip the new search to done", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 1 });
    fake.emit("info depth 99 score cp 50 pv e2e4"); // A running

    const updatePromise = provider.update({ fen: FEN_B, multipv: 1 });
    await tick(); // drain is now active (stop posted), awaiting A's bestmove
    fake.emit("bestmove e2e4"); // A concludes → drain done, B launches
    await updatePromise;

    // B is searching; deliver its real info and confirm a clean, B-only snapshot.
    fake.emit("info depth 30 score cp -10 pv d7d5");
    const snap = provider.snapshot();
    expect(snap.running).toBe(true);
    expect(snap.current_depth).toBe(30);
    expect(snap.pvs[0].score_cp).toBe(10); // -10 from Black's POV → +10 White-POV
  });

  it("serializes overlapping update() calls so neither caller's promise is orphaned (P1)", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 1 });
    fake.emit("info depth 99 score cp 10 pv e2e4"); // A running

    // Fire two updates back-to-back WITHOUT awaiting between them — the exact race the Engine
    // widget hits when a multipv change lands mid board-change drain.
    let r1 = false;
    let r2 = false;
    const p1 = provider.update({ fen: FEN_B, multipv: 1 }).then(() => (r1 = true));
    const p2 = provider.update({ fen: FEN_C, multipv: 1 }).then(() => (r2 = true));

    await tick(); // update#1 runs, drains A (posts stop); update#2 is queued behind it
    expect(r1).toBe(false);
    expect(r2).toBe(false);

    fake.emit("bestmove e2e4"); // A concludes → update#1 launches B and resolves
    await tick();
    expect(r1).toBe(true); // NOT orphaned (the pre-fix bug hung this one forever)
    expect(provider.snapshot().fen).toBe(FEN_B);

    fake.emit("bestmove d2d4"); // update#2 (now running) drains B → launches C
    await Promise.all([p1, p2]);
    expect(r2).toBe(true);
    expect(provider.snapshot().fen).toBe(FEN_C);
  });

  it("tears down a wedged worker on drain timeout so its late output cannot pollute (P2)", async () => {
    vi.useFakeTimers();
    try {
      const workers = [];
      const provider = createStockfishWasmProvider({
        createWorker: () => {
          const w = new FakeWorker();
          workers.push(w);
          return w;
        },
      });
      await provider.open({ fen: FEN_A, multipv: 1 });
      workers[0].emit("info depth 99 score cp 10 pv e2e4"); // A running, but it will NEVER bestmove

      const updatePromise = provider.update({ fen: FEN_B, multipv: 1 });
      // Let the queued update reach drainCurrentSearch (arming the timeout), then fire it.
      // advanceTimersByTimeAsync flushes the microtasks between, driving the re-open to completion.
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15000); // drain timeout → worker torn down, B re-launched
      await updatePromise;

      expect(workers.length).toBe(2); // a fresh worker replaced the wedged one
      expect(workers[0].terminated).toBe(true); // the wedged worker was actually torn down
      expect(provider.snapshot().fen).toBe(FEN_B);

      // The OLD worker now spews its late output — it must not touch the new state at all.
      workers[0].emit("info depth 99 score cp 9999 pv a2a3a4");
      workers[0].emit("bestmove a2a3");
      const snap = provider.snapshot();
      expect(snap.pvs).toEqual([]); // no stale pv leaked in
      expect(snap.current_depth).toBe(0);
      expect(snap.running).toBe(true); // the dead worker's bestmove did NOT end B
    } finally {
      vi.useRealTimers();
    }
  });

  it("close() during a drain does not resurrect a worker or relaunch a search (P1)", async () => {
    const workers = [];
    const provider = createStockfishWasmProvider({
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    await provider.open({ fen: FEN_A, multipv: 1 });
    workers[0].emit("info depth 99 score cp 10 pv e2e4"); // A running

    // Switch FENs so update() enters the drain, then close the provider mid-drain — close()
    // resolves the drain to unblock the awaiting startSearch, which must NOT then recreate a
    // worker and `go` on a torn-down provider.
    const updatePromise = provider.update({ fen: FEN_B, multipv: 1 });
    await tick(); // update() drains A (posts stop), awaiting A's bestmove
    expect(workers[0].posted).toContain("stop");

    await provider.close();
    await updatePromise; // the orphaned op must settle, not hang

    expect(workers.length).toBe(1); // no fresh worker was spun up after close()
    expect(workers[0].terminated).toBe(true); // the one worker was torn down by close()
    expect(provider.snapshot().running).toBe(false); // no search left running on a closed provider

    // The reused provider revives cleanly on the next open() (app.js keeps the instance).
    await provider.open({ fen: FEN_C, multipv: 1 });
    expect(workers.length).toBe(2);
    expect(provider.snapshot().fen).toBe(FEN_C);
    expect(provider.snapshot().running).toBe(true);
  });

  it("close() does not let an update queued behind the drain resurrect the provider (P1)", async () => {
    const workers = [];
    const provider = createStockfishWasmProvider({
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    await provider.open({ fen: FEN_A, multipv: 1 });
    workers[0].emit("info depth 99 score cp 10 pv e2e4"); // A running

    // TWO updates queued: #1 drains A; #2 waits behind #1 on opChain. A per-op "revive" flag would
    // let #2 flip the provider back open after close() — the generation token must stop that.
    const p1 = provider.update({ fen: FEN_B, multipv: 1 });
    const p2 = provider.update({ fen: FEN_C, multipv: 1 });
    await tick(); // #1 enters the drain (posts stop); #2 is queued behind it
    expect(workers[0].posted).toContain("stop");

    await provider.close(); // both queued ops captured the pre-close generation → both must bail
    await Promise.allSettled([p1, p2]);

    expect(workers.length).toBe(1); // no fresh worker spun up by the queued #2 after close()
    expect(workers[0].terminated).toBe(true);
    expect(provider.snapshot().running).toBe(false);
  });

  it("close() during the init handshake settles the pending op and keeps opChain usable (P1)", async () => {
    const workers = [];
    let autoReady = false; // first worker hangs in handshake; later workers answer normally
    const provider = createStockfishWasmProvider({
      createWorker: () => {
        const w = new FakeWorker({ autoReady });
        workers.push(w);
        return w;
      },
    });

    let firstSettled = null;
    const firstOpen = provider
      .open({ fen: FEN_A, multipv: 1 })
      .then(() => (firstSettled = "resolved"), () => (firstSettled = "rejected"));
    await tick(); // worker created, `isready` posted, but no `readyok` → open() is awaiting
    expect(firstSettled).toBe(null);
    expect(workers.length).toBe(1);

    await provider.close(); // must settle the pending handshake, not leave it hanging
    await firstOpen;
    expect(firstSettled).toBe("rejected"); // open() settled (rejected), did NOT hang forever

    // opChain must not be wedged: a fresh open() on the reused instance still works.
    autoReady = true;
    await provider.open({ fen: FEN_B, multipv: 1 });
    expect(workers.length).toBe(2);
    expect(provider.snapshot().fen).toBe(FEN_B);
    expect(provider.snapshot().running).toBe(true);
  });

  it("a worker error during a drain surfaces the error instead of silently rebuilding (P2)", async () => {
    const workers = [];
    const provider = createStockfishWasmProvider({
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    await provider.open({ fen: FEN_A, multipv: 1 });
    workers[0].emit("info depth 99 score cp 10 pv e2e4"); // A running

    const updatePromise = provider.update({ fen: FEN_B, multipv: 1 });
    await tick(); // update() drains A (posts stop), awaiting A's bestmove
    expect(workers[0].posted).toContain("stop");

    // The worker dies mid-drain instead of concluding. failReady() must bump the generation so the
    // awaiting startSearch bails rather than quietly spinning up a fresh worker and masking the error.
    workers[0].onerror({ message: "worker crashed" });
    await updatePromise; // settles (does not hang), carrying the error

    expect(workers.length).toBe(1); // no second worker silently created
    expect(provider.snapshot().error).toBe("worker crashed"); // error surfaced, not swallowed
    expect(provider.snapshot().running).toBe(false);

    // A fresh open() recovers cleanly AND re-sends ucinewgame (newGameSent was reset on failure).
    await provider.open({ fen: FEN_C, multipv: 1 });
    expect(workers.length).toBe(2);
    expect(workers[1].posted).toContain("ucinewgame");
    expect(provider.snapshot().error).toBe(null);
    expect(provider.snapshot().fen).toBe(FEN_C);
  });

  it("waitForSearchComplete rejects at the exact timeout deadline (>=, not >)", async () => {
    vi.useFakeTimers();
    try {
      const { provider } = makeProvider();
      await provider.open({ fen: FEN_A, multipv: 1 });

      const waitPromise = provider.waitForSearchComplete({ targetDepth: 20, timeoutMs: 1000 });
      const assertion = expect(waitPromise).rejects.toThrow(/timed out after 1000ms/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("close() immediately rejects pending waitForSearchComplete waiters", async () => {
    const { provider } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 1 });

    const waitPromise = provider.waitForSearchComplete({ targetDepth: 20, timeoutMs: 30000 });
    await provider.close();

    await expect(waitPromise).rejects.toThrow(/Browser engine closed/);
  });

  it("waitForSearchComplete resolves immediately when the search already finished", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 1 });
    fake.emit("info depth 20 score cp 40 pv e2e4");
    fake.emit("bestmove e2e4");
    expect(provider.snapshot().running).toBe(false);

    const snap = await provider.waitForSearchComplete({ targetDepth: 20, timeoutMs: 30000 });
    expect(snap.current_depth).toBe(20);
    expect(snap.pvs[0].score_cp).toBe(40);
  });

  it("waitForSearchComplete resolves on worker messages without polling (background-tab safe)", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 1 });

    const waitPromise = provider.waitForSearchComplete({ targetDepth: 20, timeoutMs: 30000 });
    await tick();
    fake.emit("info depth 20 score cp 40 pv e2e4");
    fake.emit("bestmove e2e4");

    const snap = await waitPromise;
    expect(snap.current_depth).toBe(20);
    expect(snap.pvs[0].score_cp).toBe(40);
    // Resolves as soon as target depth is reached — need not wait for bestmove (game-analyzer parity).
    expect(snap.running).toBe(true);
  });

  it("does not drain when the previous search already finished (no hang)", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN_A, multipv: 1 });
    fake.emit("info depth 20 score cp 40 pv e2e4");
    fake.emit("bestmove e2e4"); // A done, running=false
    expect(provider.snapshot().running).toBe(false);

    // No search in flight → update resolves without waiting for any bestmove.
    await provider.update({ fen: FEN_B, multipv: 1 });
    expect(provider.snapshot().fen).toBe(FEN_B);
    expect(provider.snapshot().running).toBe(true);
  });
});
