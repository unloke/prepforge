import { describe, it, expect, vi } from "vitest";
import { createEngineProfileManager, reserveEngineMemory, stepDownProfile, PROFILE_KEY, CRASH_KEY, PROBE_NODES, maxWorkers } from "./engine-profile.js";
import { EngineAssetError } from "./engine-assets.js";
import { createComputeBudget } from "./compute-budget.js";

const STEPS = [["lite", 1], ["big", 1], ["big", 2], ["big", 3]];
function fixture({ throughput = (_net, n) => n, Memory = class { constructor(options) { this.options = options; } },
  prepare, search, ...options } = {}) {
  const data = new Map();
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  const engines = [];
  const modules = { lite: {}, big: {} };
  const loadModule = vi.fn(async net => modules[net]);
  const reserveMemory = vi.fn(net => reserveEngineMemory(net, Memory));
  const createEngine = vi.fn(async opts => {
    const index = engines.length;
    const engine = { net: opts.net, closed: false,
      prepare: vi.fn(async () => prepare?.(index, opts)), open: vi.fn(async () => {}),
      waitForSearchComplete: vi.fn(async () => {
        await search?.(index, opts);
        const n = engines.filter(e => !e.closed).length;
        return { nodes: opts.maxNodes * throughput(opts.net, n) / n };
      }),
      close: vi.fn(async () => { engine.closed = true; }),
    };
    engines.push(engine);
    return engine;
  });
  let t = 0;
  const manager = createEngineProfileManager({ storage: () => storage, createEngine, reserveMemory, loadModule,
    assetState: () => ({ phase: "ready" }), subscribeAsset: () => () => {}, beginSession: () => () => {},
    probeBudget: async () => () => {}, device: () => ({ hardwareConcurrency: 4, deviceMemory: 8 }), now: () => (t += 1000), ...options });
  return { ...manager, data, storage, engines, createEngine, reserveMemory, loadModule, modules };
}

describe("device engine profile", () => {
  it.each(["idle", "download", "compile", "error"])("uses lite x1 while the recommended full net is %s", phase => {
    const f = fixture({ assetState: () => ({ phase }) });
    f.setEngineProfile({ net: "big", workers: 3 });
    expect(f.engineProfile()).toMatchObject({ net: "big", workers: 3 });
    expect(f.usableEngineProfile()).toMatchObject({ net: "lite", workers: 1 });
  });

  it("waits for a cached full net before a run, never for a download", async () => {
    for (const [phase, waits] of [["compile", true], ["download", false]]) {
      let finish;
      const f = fixture({ subscribeAsset: (net, fn) => { fn({ phase: "idle" }); queueMicrotask(() => fn({ phase })); return () => {}; },
        loadModule: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
      f.setEngineProfile({ net: "big", workers: 2 });
      let done = false;
      const wait = f.readyIfCached().then(() => { done = true; });
      await new Promise(r => setTimeout(r, 0));
      expect(done).toBe(!waits);
      finish({});
      await wait;
      expect(done).toBe(true);
    }
  });
  it("pins lite until the session ends even if the full asset becomes ready", () => {
    let phase = "download", notify;
    const f = fixture({ assetState: () => ({ phase }),
      subscribeAsset: (net, fn) => { if (net === "big") notify = fn; return () => {}; } });
    f.setEngineProfile({ net: "big", workers: 3 });
    const listener = vi.fn();
    f.subscribeUsableEngineProfile(listener);
    const run = f.createEngineAnalysisRun();
    phase = "ready"; notify({ phase, loaded: 100, total: 100 });
    expect(run.start()).toMatchObject({ net: "lite", workers: 1 });
    expect(run.start()).toMatchObject({ net: "lite", workers: 1 });
    expect(listener).not.toHaveBeenCalled();
    run.done();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ net: "big", workers: 3 }));
  });

  it("publishes a completed probe only after the entire active session ends", async () => {
    let run;
    const f = fixture({ prepare: index => { if (!index) run = f.createEngineAnalysisRun(); } });
    const listener = vi.fn(); f.subscribeEngineProfile(listener);
    await f.detectEngineProfile();
    expect(listener).not.toHaveBeenCalled();
    expect(f.engineProfile()).toMatchObject({ net: "lite", workers: 1 });
    expect(run.start()).toMatchObject({ net: "lite", workers: 1 });
    run.done();
    expect(f.engineProfile()).toMatchObject({ net: "big", workers: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("prepares full only on the first engine start of the page", async () => {
    const f = fixture();
    expect(f.loadModule).not.toHaveBeenCalled();
    f.engineStarted(); f.engineStarted();
    await vi.waitFor(() => expect(f.engineProfile().source).toBe("detected"));
    expect(f.loadModule.mock.calls[0]).toEqual(["big"]);
    expect(f.engines).toHaveLength(4);
  });

  it("saveData skips automatic preparation but explicit Full and Detect still work", async () => {
    const f = fixture({ device: () => ({ connection: { saveData: true }, hardwareConcurrency: 1 }) });
    f.engineStarted();
    await Promise.resolve();
    expect(f.loadModule).not.toHaveBeenCalled();
    await f.prepareFullEngine();
    expect(f.loadModule).toHaveBeenCalledWith("big");
    await f.detectEngineProfile();
    expect(f.engineProfile()).toMatchObject({ net: "big", workers: 1 });
  });

  it("remembers a failed big-one reservation and does not automatically prepare it on return", async () => {
    const f = fixture({ Memory: class { constructor(descriptor) {
      if (descriptor.initial === globalThis.__STOCKFISH__.big.initialHeapPages) throw new RangeError("no address space");
    } } });
    await f.detectEngineProfile();
    expect(f.engineProfile()).toMatchObject({ net: "lite", workers: 1 });
    const loadModule = vi.fn();
    const next = createEngineProfileManager({ storage: () => f.storage, loadModule, device: () => ({ hardwareConcurrency: 4, deviceMemory: 8 }) });
    next.engineStarted();
    expect(next.engineProfile()).toMatchObject({ net: "lite", workers: 1 });
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("replays asset bytes and compilation to a subscriber joining background preparation", async () => {
    let asset;
    const f = fixture({ subscribeAsset: (net, fn) => { if (net === "big") asset = fn; return () => {}; } });
    const first = vi.fn(); f.subscribeEngineSetup(first);
    asset({ phase: "download", loaded: 25, total: 100 });
    const late = vi.fn(), unsubscribe = f.subscribeEngineSetup(late);
    expect(late).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "download", loaded: 25, total: 100, fraction: 0.25 }));
    asset({ phase: "compile", loaded: 100, total: 100 });
    expect(late).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "compile", fraction: 1, label: "Compiling engine…" }));
    unsubscribe(); const calls = late.mock.calls.length;
    asset({ phase: "ready", loaded: 100, total: 100 });
    expect(late).toHaveBeenCalledTimes(calls);
  });

  it("cancels probe workers on foreground demand and retries only once foreground is idle", async () => {
    let resumePrepare;
    const budget = createComputeBudget({ scheduleIdle: fn => setTimeout(fn, 0) });
    const f = fixture({ probeBudget: opts => budget.acquireProbe(opts),
      prepare: index => index === 0 ? new Promise(resolve => { resumePrepare = resolve; }) : undefined });
    const detection = f.detectEngineProfile();
    await vi.waitFor(() => expect(resumePrepare).toBeTypeOf("function"));
    const reclaim = vi.fn();
    const release = await budget.acquire({ interactive: true, reclaim });
    expect(f.engines[0].closed).toBe(true);
    expect(reclaim).not.toHaveBeenCalled();
    resumePrepare();
    await vi.waitFor(() => expect(f.engineSetupState().phase).toBe("waiting"));
    expect(f.engineProfile().source).toBe("fallback");
    release();
    expect(await detection).toMatchObject({ net: "big", workers: 3 });
    expect(f.engines.every(e => e.closed)).toBe(true);
    expect(f.data.has(CRASH_KEY)).toBe(false);
  });

  it("persists and validates a user choice, notifies and unsubscribes", () => {
    const f = fixture();
    expect(f.engineProfile()).toEqual({ net: "lite", workers: 1, source: "fallback" });
    const listener = vi.fn();
    const unsubscribe = f.subscribeEngineProfile(listener);
    f.setEngineProfile({ net: "big", workers: 2 });
    expect(f.engineProfile()).toEqual({ net: "big", workers: 2, source: "user" });
    expect(createEngineProfileManager({ storage: () => f.storage, device: () => ({ hardwareConcurrency: 4, deviceMemory: 8 }) }).engineProfile()).toEqual(f.engineProfile());
    expect(() => f.setEngineProfile({ net: "big", workers: 4 })).toThrow(RangeError);
    unsubscribe();
    f.resetEngineProfile();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("uses fallback with inaccessible, malformed or unwritable storage", async () => {
    const f = fixture({ storage: () => { throw new Error("blocked"); } });
    expect(f.setEngineProfile({ net: "big", workers: 3 })).toMatchObject({ net: "lite", source: "fallback" });
    expect(await f.detectEngineProfile()).toMatchObject({ net: "lite", source: "fallback" });
    expect(f.createEngine).not.toHaveBeenCalled();
    const malformed = fixture();
    malformed.data.set(PROFILE_KEY, "{");
    expect(malformed.engineProfile()).toMatchObject({ source: "fallback" });
    const unwritable = fixture({ storage: () => ({ getItem: () => null, setItem() { throw new Error("quota"); } }) });
    expect(unwritable.setEngineProfile({ net: "big", workers: 3 })).toMatchObject({ source: "fallback" });
  });

  it("ascends from lite 1, measures each net, and stops at the last worthwhile worker", async () => {
    const f = fixture({ throughput: (net, n) => net === "lite" ? 0.5 : [0, 1, 1.8, 2.1][n] });
    expect(await f.detectEngineProfile()).toMatchObject({ net: "big", workers: 2, source: "detected" });
    expect(f.createEngine.mock.calls.map(([o]) => o.net)).toEqual(["lite", "big", "big", "big"]);
    expect(f.loadModule.mock.calls).toEqual([["lite"], ["big"]]);
    for (const [opts] of f.createEngine.mock.calls) expect(opts.wasmModule).toBe(f.modules[opts.net]);
    const N = PROBE_NODES;
    expect(f.engineMeasurements()).toMatchObject({ nodes: 1.8 * N, searchMs: 1000, nodesPerSecond: 1.8 * N,
      scaling: { lite: [0.5 * N], big: [N, 1.8 * N, 2.1 * N] } });
    expect(f.engines.every(e => e.close.mock.calls.length === 1)).toBe(true);
    expect(f.engines.every(e => e.open.mock.calls.every(([o]) => o.newGame === true && o.depth === 60))).toBe(true);
    expect(new Set(f.engines.flatMap(e => e.open.mock.calls.map(([o]) => o.fen))).size).toBe(1);
    expect(f.data.has(CRASH_KEY)).toBe(false);
    f.setEngineProfile({ net: "lite", workers: 3 });
    expect(f.resetEngineProfile()).toMatchObject({ net: "big", workers: 2, source: "detected" });
  });

  it.each([false, true])("asset waits have no crash marker or reservation, including cancellation (%s)", async cancel => {
    let resolveModule;
    const module = new Promise(resolve => { resolveModule = resolve; });
    const controller = new AbortController();
    const f = fixture({ loadModule: () => module });
    const pending = f.detectEngineProfile({ signal: controller.signal }).catch(error => error);
    await Promise.resolve(); await Promise.resolve();
    expect(f.data.has(CRASH_KEY)).toBe(false);
    expect(f.reserveMemory).not.toHaveBeenCalled();
    expect(f.createEngine).not.toHaveBeenCalled();
    if (cancel) controller.abort();
    resolveModule({});
    const result = await pending;
    if (cancel) {
      expect(result.name).toBe("AbortError");
      expect(f.createEngine).not.toHaveBeenCalled();
    } else expect(result).toMatchObject({ net: "big", workers: 3 });
    expect(f.data.has(CRASH_KEY)).toBe(false);
  });

  it.each(["lite", "big"])("does not replace a user profile when the %s asset fails", async failedNet => {
    const error = new EngineAssetError(new Error("download aborted"));
    const f = fixture({ loadModule: async net => {
      expect(f.data.has(CRASH_KEY)).toBe(false);
      if (net === failedNet) throw error;
      return {};
    } });
    f.setEngineProfile({ net: "big", workers: 3 });
    await expect(f.detectEngineProfile()).rejects.toBe(error);
    expect(f.engineProfile()).toMatchObject({ net: "big", workers: 3, source: "user" });
    expect(f.reserveMemory).not.toHaveBeenCalled();
    expect(f.data.has(CRASH_KEY)).toBe(false);
  });

  it.each([1.49, 1.5])("compares extra worker gain with the net's one-worker baseline (%s)", async gain => {
    const f = fixture({ device: () => ({ hardwareConcurrency: 2, deviceMemory: 8 }), throughput: (_net, n) => n === 1 ? 1 : gain });
    expect(await f.detectEngineProfile()).toMatchObject({ net: "big", workers: gain < 1.5 ? 1 : 2 });
    expect(f.engines).toHaveLength(3);
  });

  it("preserves a user choice when detection finishes", async () => {
    const f = fixture();
    const result = f.detectEngineProfile();
    f.setEngineProfile({ net: "lite", workers: 3 });
    expect(await result).toMatchObject({ net: "lite", source: "user" });
    expect(f.resetEngineProfile()).toMatchObject({ net: "big", workers: 3, source: "detected" });
  });

  it.each(STEPS.flatMap(([net, workers]) => ["load", "search"].map(phase => [net, workers, phase])))(
    "a killed %s %i probe during %s recovers the preceding step without reprobing", async (net, workers, phase) => {
    const step = STEPS.findIndex(s => s[0] === net && s[1] === workers);
    const previous = STEPS[Math.max(0, step - 1)];
    expect(stepDownProfile({ net, workers })).toMatchObject({ net: previous[0], workers: previous[1] });
    let checked = false;
    const f = fixture({ [phase === "load" ? "prepare" : "search"]: index => {
      if (checked || index !== step) return;
      checked = true;
      expect(JSON.parse(f.data.get(CRASH_KEY))).toMatchObject({ net, workers });
      const nextLoad = createEngineProfileManager({ storage: () => f.storage, createEngine: () => { throw new Error("must not probe"); }, device: () => ({ hardwareConcurrency: 4, deviceMemory: 8 }) });
      expect(nextLoad.engineProfile()).toEqual({ net: previous[0], workers: previous[1], source: "fallback" });
      expect(nextLoad.engineProfile().source).toBe("fallback");
    } });
    expect(await f.detectEngineProfile()).not.toHaveProperty("measurements.error");
    expect(checked).toBe(true);
  });

  it.each(["load", "search"])("stops on %s failure at each step and keeps the last completed round", async phase => {
    for (let failed = 0; failed < STEPS.length; failed++) {
      const fail = index => { if (index === failed) throw new Error(phase === "load" ? "load failed" : "OOM"); };
      const f = fixture({ [phase === "load" ? "prepare" : "search"]: fail });
      const previous = STEPS[Math.max(0, failed - 1)];
      expect(await f.detectEngineProfile()).toMatchObject({ net: previous[0], workers: previous[1],
        source: failed ? "detected" : "fallback", measurements: { error: phase === "load" ? "load failed" : "OOM" } });
      expect(f.createEngine).toHaveBeenCalledTimes(failed + 1);
      expect(f.engines.every(e => e.closed)).toBe(true);
      expect(f.data.has(CRASH_KEY)).toBe(false);
    }
  });

  it.each([RangeError, Error])("a throwing %s reservation never loads the next worker", async ErrorType => {
    for (let failed = 0; failed < STEPS.length; failed++) {
      let allocations = 0;
      const f = fixture({ Memory: class {
        constructor(descriptor) {
          const step = allocations++;
          const [net, workers] = STEPS[step];
          expect(JSON.parse(f.data.get(CRASH_KEY))).toMatchObject({ net, workers });
          expect(descriptor).toEqual({ initial: globalThis.__STOCKFISH__[net].initialHeapPages,
            maximum: globalThis.__STOCKFISH__[net].maxHeapPages, shared: true });
          expect(f.engines.filter(e => !e.closed)).toHaveLength(workers - 1);
          if (step === failed) throw new ErrorType("no address space");
        }
      } });
      const previous = STEPS[Math.max(0, failed - 1)];
      expect(await f.detectEngineProfile()).toMatchObject({ net: previous[0], workers: previous[1],
        measurements: { error: "no address space" } });
      expect(f.createEngine).toHaveBeenCalledTimes(failed);
      for (const [index, [opts]] of f.createEngine.mock.calls.entries()) {
        expect(opts.wasmMemory).toBe(f.reserveMemory.mock.results[index].value);
      }
      expect(f.data.has(CRASH_KEY)).toBe(false);
    }
  });

  it.each([{ hardwareConcurrency: 1 }, { hardwareConcurrency: 8, deviceMemory: 2 },
    { hardwareConcurrency: 8, deviceMemory: 4 }])("bounds the big ladder by cores and RAM: %j", async device => {
    const f = fixture({ device: () => device });
    expect(await f.detectEngineProfile()).toMatchObject({ net: "big", workers: maxWorkers(device) });
    expect(f.engines).toHaveLength(1 + maxWorkers(device));
  });

  it("reports rising progress to every caller, including one that joins late", async () => {
    const f = fixture();
    const first = [], late = [];
    const unsubscribe = f.subscribeEngineSetup(p => first.push(p));
    const run = f.detectEngineProfile();
    await Promise.resolve();
    const unsubscribeLate = f.subscribeEngineSetup(p => late.push(p));
    expect(late[0]).toEqual(first.at(-1));
    const joined = f.detectEngineProfile();
    await Promise.all([run, joined]);
    const total = (1 + maxWorkers({ hardwareConcurrency: 4, deviceMemory: 8 })) * 3;
    expect(first.map(p => p.done)).toEqual([...first.map(p => p.done)].sort((a, b) => a - b));
    expect(first.at(-1)).toMatchObject({ stage: "complete", done: total, probeTotal: total, fraction: 1 });
    expect(first.some(p => p.stage === "workers")).toBe(true);
    expect(late.at(-1)).toMatchObject({ stage: "complete", done: total });
    unsubscribe(); unsubscribeLate();
  });
  it("cleans up an aborted probe and permits another detection", async () => {
    const controller = new AbortController();
    let stopped = false;
    const f = fixture({ prepare: () => { if (!stopped) { stopped = true; controller.abort(); } } });
    await expect(f.detectEngineProfile({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(f.data.has(CRASH_KEY)).toBe(false);
    expect(f.engines.every(e => e.closed)).toBe(true);
    expect(await f.detectEngineProfile()).toMatchObject({ net: "big", workers: 3 });
  });

  it("detects again on a new build, keeping only explicit user choices", async () => {
    const f = fixture({ probeId: "old" });
    await f.detectEngineProfile();
    const rebuilt = createEngineProfileManager({ storage: () => f.storage, probeId: "new", device: () => ({ hardwareConcurrency: 4, deviceMemory: 8 }) });
    expect(rebuilt.engineProfile()).toMatchObject({ source: "fallback" });
    expect(rebuilt.engineMeasurements()).toBeNull();
    f.setEngineProfile({ net: "lite", workers: 2 });
    expect(createEngineProfileManager({ storage: () => f.storage, probeId: "new", device: () => ({ hardwareConcurrency: 4, deviceMemory: 8 }) }).engineProfile())
      .toEqual({ net: "lite", workers: 2, source: "user" });
  });

  it("holds a whole-run guard across searches and clears/re-arms it with page visibility", () => {
    const page = new EventTarget(), lifecycle = new EventTarget();
    page.visibilityState = "visible";
    const f = fixture({ page, lifecycle });
    f.setEngineProfile({ net: "big", workers: 2 });
    const run = f.createEngineAnalysisRun();
    run.start();
    run.start(); // another batch in the same analysis, still one guard
    expect(JSON.parse(f.data.get(CRASH_KEY))).toMatchObject({ net: "big", workers: 2 });
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(f.data.has(CRASH_KEY)).toBe(false);
    expect(createEngineProfileManager({ storage: () => f.storage, device: () => ({ hardwareConcurrency: 4, deviceMemory: 8 }) }).engineProfile()).toMatchObject({ net: "big", workers: 2 });
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(f.data.has(CRASH_KEY)).toBe(true);
    lifecycle.dispatchEvent(new Event("pagehide"));
    expect(f.data.has(CRASH_KEY)).toBe(false);
    lifecycle.dispatchEvent(new Event("pageshow"));
    expect(f.data.has(CRASH_KEY)).toBe(true);
    run.done(); run.done();
    page.dispatchEvent(new Event("visibilitychange"));
    expect(f.data.has(CRASH_KEY)).toBe(false);
  });

  it("does not arm a run that starts hidden, and keeps overlapping guards until both finish", () => {
    const page = new EventTarget(); page.visibilityState = "hidden";
    const f = fixture({ page });
    const a = f.guardEngineStartup(), b = f.guardEngineStartup();
    expect(f.data.has(CRASH_KEY)).toBe(false);
    page.visibilityState = "visible"; page.dispatchEvent(new Event("visibilitychange"));
    a.done();
    expect(f.data.has(CRASH_KEY)).toBe(true);
    b.done();
    expect(f.data.has(CRASH_KEY)).toBe(false);
  });

  it("shares one retry budget across batches and cannot retry below lite 1", () => {
    const f = fixture();
    f.setEngineProfile({ net: "big", workers: 3 });
    const run = f.createEngineAnalysisRun();
    expect(run.start()).toMatchObject({ net: "big", workers: 3 });
    expect(run.retry(new Error("OOM"))).toBe(true);
    expect(run.start()).toMatchObject({ net: "big", workers: 2 });
    const error = new Error("Aborted");
    expect(run.retry(error)).toBe(false);
    expect(run.error).toBe(error);
    expect(f.engineProfile()).toMatchObject({ net: "big", workers: 1 });
    expect(f.data.has(CRASH_KEY)).toBe(false);
    const smallest = fixture();
    const listener = vi.fn(); smallest.subscribeEngineProfile(listener);
    const baseline = smallest.createEngineAnalysisRun(); baseline.start();
    expect(baseline.retry(error)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    run.done(); baseline.done();
  });
});


// A device's setup is its own. Nothing a desktop measured may reach a phone (the
// record lives in this browser), and "no memory signal" is not "assume one engine":
// the ladder grows one heap at a time and each step is proven by reserving that
// step's heap. The blanket one-engine cap is gone.
describe("every device gets its own measured setup", () => {
  const DESKTOP = { hardwareConcurrency: 20, deviceMemory: 32 };
  // WebKit exposes cores but no memory signal at all — the shape of an iPhone.
  const PHONE = { hardwareConcurrency: 6 };
  const LADDER = [["lite", 1], ["big", 1], ["big", 2], ["big", 3]];
  // A Memory whose constructor throws at one ladder step.
  const memoryFailingAt = (failAt) => {
    let allocated = 0;
    return class {
      constructor(descriptor) {
        if (allocated++ === failAt) throw new RangeError("no address space");
        this.descriptor = descriptor;
      }
    };
  };

  it("keeps the memory signal as a ceiling where the browser reports one", () => {
    expect(maxWorkers(DESKTOP)).toBe(3);
    expect(maxWorkers({ hardwareConcurrency: 8, deviceMemory: 2 })).toBe(1);
    expect(maxWorkers({ hardwareConcurrency: 8, deviceMemory: 4 })).toBe(2);
    expect(maxWorkers({ hardwareConcurrency: 1, deviceMemory: 32 })).toBe(1);
    // No signal is not "small": cores bound the ladder, not a made-up memory limit.
    expect(maxWorkers(PHONE)).toBe(3);
    expect(maxWorkers({ hardwareConcurrency: 2 })).toBe(2);
    expect(maxWorkers({})).toBe(1);
  });

  it("measures a phone up the whole ladder when every heap fits", async () => {
    const phone = fixture({ device: () => PHONE, throughput: (_net, n) => n });
    expect(await phone.detectEngineProfile()).toMatchObject({ net: "big", workers: 3, source: "detected" });
    // lite 1, big 1, big 2, big 3: each step reserved its own heap.
    expect(phone.createEngine.mock.calls.map(([o]) => o.net)).toEqual(["lite", "big", "big", "big"]);
    expect(phone.engineWorkerChoices()).toEqual({ lite: 3, big: 3 });
  });

  it("records the last step that held when a bigger reservation fails", async () => {
    // big x2 cannot be reserved on this phone: Detect keeps big x1 and stops.
    const phone = fixture({ device: () => PHONE, throughput: (_net, n) => n,
      Memory: memoryFailingAt(LADDER.findIndex(([n, w]) => n === "big" && w === 2)) });
    expect(await phone.detectEngineProfile()).toMatchObject({ net: "big", workers: 1, source: "detected",
      measurements: { error: "no address space" } });
    expect(phone.createEngine).toHaveBeenCalledTimes(2);
    expect(phone.engineWorkerChoices()).toEqual({ lite: 1, big: 1 });
    expect(phone.data.has(CRASH_KEY)).toBe(false);
    // The next load starts where this one stopped.
    const reloaded = createEngineProfileManager({ storage: () => phone.storage, device: () => PHONE,
      assetState: () => ({ phase: "ready" }) });
    expect(reloaded.engineProfile()).toMatchObject({ net: "big", workers: 1 });
    expect(reloaded.engineWorkerChoices()).toEqual({ lite: 1, big: 1 });
  });

  it("records the attempted step before trying it, so a killed tab never retries it", async () => {
    let crashed = false;
    const phone = fixture({ device: () => PHONE, throughput: (_net, n) => n, prepare: (index) => {
      if (crashed || index !== 2) return;
      crashed = true;
      // The tab dies at big x2: the armed step is on disk, and a fresh load
      // starts below it without retrying the step that killed the tab.
      expect(JSON.parse(phone.data.get(CRASH_KEY))).toMatchObject({ net: "big", workers: 2 });
      const reloaded = createEngineProfileManager({ storage: () => phone.storage, device: () => PHONE,
        createEngine: () => { throw new Error("must not retry the killed step"); } });
      expect(reloaded.engineProfile()).toEqual({ net: "big", workers: 1, source: "fallback" });
      expect(reloaded.engineWorkerChoices()).toEqual({ lite: 1, big: 1 });
    } });
    await phone.detectEngineProfile();
    expect(crashed).toBe(true);
  });

  it("arms the probe step even in a hidden tab", () => {
    const page = new EventTarget();
    page.visibilityState = "hidden";
    const f = fixture({ page, device: () => PHONE });
    f.guardEngineStartup({ net: "big", workers: 2 }, { sticky: true });
    expect(JSON.parse(f.data.get(CRASH_KEY))).toMatchObject({ net: "big", workers: 2 });
    // A foreground engine run keeps the old rule: hidden means nothing to report.
    const g = fixture({ page });
    g.guardEngineStartup();
    expect(g.data.has(CRASH_KEY)).toBe(false);
  });

  it("a desktop with plenty of memory still reaches its best setup", async () => {
    const desktop = fixture({ device: () => DESKTOP });
    expect(await desktop.detectEngineProfile()).toMatchObject({ net: "big", workers: 3, source: "detected" });
    expect(desktop.engineWorkerChoices()).toEqual({ lite: 3, big: 3 });
  });

  it("a fresh device sets itself up once, after the first screen", async () => {
    const idle = [];
    const first = fixture({ device: () => PHONE, scheduleIdle: fn => { idle.push(fn); } });
    first.setupOnFirstVisit();
    first.setupOnFirstVisit();
    expect(idle).toHaveLength(1);
    expect(first.createEngine).not.toHaveBeenCalled();
    idle[0]();
    await vi.waitFor(() => expect(first.engineProfile().source).toBe("detected"));
    expect(first.engineProfile()).toMatchObject({ net: "big", workers: 3 });
  });

  it("does not set up a device that already has a setup, or one on save-data", async () => {
    const settled = fixture({ device: () => PHONE, scheduleIdle: fn => fn() });
    settled.setEngineProfile({ net: "lite", workers: 1 });
    settled.setupOnFirstVisit();
    await Promise.resolve();
    expect(settled.createEngine).not.toHaveBeenCalled();
    const throttled = fixture({ device: () => ({ ...PHONE, connection: { saveData: true } }), scheduleIdle: fn => fn() });
    throttled.setupOnFirstVisit();
    await Promise.resolve();
    expect(throttled.createEngine).not.toHaveBeenCalled();
  });

  it("a stored record cannot start more heaps than this device measured", () => {
    // A record from a bigger device (or an edited one) is bounded by this device's
    // own ladder: it only ever held big x1.
    const phone = fixture({ device: () => PHONE });
    phone.data.set(PROFILE_KEY, JSON.stringify({
      profile: { net: "big", workers: 3, source: "user" }, detected: { net: "big", workers: 3, source: "detected" },
      measurements: null, proven: { lite: 1, big: 1 }, probe: `4:${globalThis.__STOCKFISH__?.big?.id}`,
    }));
    const reloaded = createEngineProfileManager({ storage: () => phone.storage, device: () => PHONE,
      assetState: () => ({ phase: "ready" }) });
    expect(reloaded.engineProfile()).toMatchObject({ net: "big", workers: 1 });
    expect(reloaded.usableEngineProfile()).toMatchObject({ net: "big", workers: 1 });
  });

  it("a busy tab that fails before its first step keeps the floor, not a phantom setup", async () => {
    // Detect could not even load lite x1. Nothing was measured, so nothing may be
    // offered beyond the floor and the profile stays the one every device starts at.
    const busy = fixture({ device: () => PHONE, prepare: () => { throw new Error("tab is busy"); } });
    expect(await busy.detectEngineProfile()).toMatchObject({ net: "lite", workers: 1,
      measurements: { error: "tab is busy" } });
    expect(busy.engineWorkerChoices()).toEqual({ lite: 1, big: 0 });
    expect(busy.setEngineProfile({ net: "big", workers: 3 })).toMatchObject({ net: "lite", workers: 1 });
  });

  it("Settings can only choose steps this device held", async () => {
    // Before its first Detect a device has only the signal bound.
    const fresh = fixture({ device: () => PHONE });
    expect(fresh.setEngineProfile({ net: "big", workers: 3 })).toMatchObject({ net: "big", workers: 3 });
    const measured = fixture({ device: () => PHONE, throughput: (_net, n) => n,
      Memory: memoryFailingAt(LADDER.findIndex(([n, w]) => n === "big" && w === 2)) });
    await measured.detectEngineProfile();
    expect(measured.setEngineProfile({ net: "big", workers: 3 })).toMatchObject({ net: "big", workers: 1 });
    expect(measured.setEngineProfile({ net: "lite", workers: 3 })).toMatchObject({ net: "lite", workers: 1 });
  });

  it("one device's measurement never reaches another", async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args) => { requests.push(args[0]); return originalFetch(...args); };
    try {
      const desktop = fixture({ device: () => DESKTOP });
      expect(await desktop.detectEngineProfile()).toMatchObject({ net: "big", workers: 3 });
      expect(requests).toEqual([]);
      expect([...desktop.data.keys()]).toEqual([PROFILE_KEY]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const phone = fixture({ device: () => PHONE });
    expect(phone.engineProfile()).toEqual({ net: "lite", workers: 1, source: "fallback" });
    expect(phone.data.has(PROFILE_KEY)).toBe(false);
  });
});
