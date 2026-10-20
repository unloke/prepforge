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

// The owner's report: Detect on a desktop, then the phone ran the same profile and
// ran out of memory. These pin the two halves of the fix: one device's measurement
// never reaches another device, and a device that has not measured gets the
// phone-safe profile instead of borrowing a bigger one.
describe("a phone never starts with a desktop's measurement", () => {
  const DESKTOP = { hardwareConcurrency: 20, deviceMemory: 32 };
  // WebKit exposes cores but no memory signal at all — the shape of the phone.
  const PHONE = { hardwareConcurrency: 6 };

  it("bounds engines by the memory signal: no signal is one engine, cores cannot raise it", () => {
    expect(maxWorkers(DESKTOP)).toBe(3);
    expect(maxWorkers(PHONE)).toBe(1);
    expect(maxWorkers({ hardwareConcurrency: 8 })).toBe(1);
    expect(maxWorkers({ hardwareConcurrency: 8, deviceMemory: 2 })).toBe(1);
    expect(maxWorkers({ hardwareConcurrency: 8, deviceMemory: 4 })).toBe(2);
    expect(maxWorkers({ hardwareConcurrency: 1, deviceMemory: 32 })).toBe(1);
    // Never below one engine, and no more than the shared ceiling.
    expect(maxWorkers({ hardwareConcurrency: 0, deviceMemory: 0 })).toBe(1);
    expect(maxWorkers({ hardwareConcurrency: 64, deviceMemory: 64 })).toBe(3);
  });

  it("Detect on the desktop stays on that device: no request, one local record", async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args) => { requests.push(args[0]); return originalFetch(...args); };
    try {
      const desktop = fixture({ device: () => DESKTOP });
      expect(await desktop.detectEngineProfile()).toMatchObject({ net: "big", workers: 3, source: "detected" });
      // Nothing about the measurement leaves the device: no settings write, no
      // request of any kind, so no other device can read it back.
      expect(requests).toEqual([]);
      expect([...desktop.data.keys()]).toEqual([PROFILE_KEY]);
      expect(JSON.parse(desktop.data.get(PROFILE_KEY))).toMatchObject({
        profile: { net: "big", workers: 3 }, detected: { net: "big", workers: 3 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    // The phone has its own (empty) storage and therefore its own safe default.
    const phone = fixture({ device: () => PHONE });
    expect(phone.engineProfile()).toEqual({ net: "lite", workers: 1, source: "fallback" });
    expect(phone.data.has(PROFILE_KEY)).toBe(false);
  });

  it("the phone's first engine start is bounded before any probe runs", () => {
    // A device that never ran Detect still starts the engine (engineStarted →
    // detect), so the bound has to hold on that path too, not only inside Detect.
    const phone = fixture({ device: () => PHONE, throughput: () => 1 });
    phone.engineStarted();
    return vi.waitFor(() => expect(phone.engineProfile().source).toBe("detected")).then(() => {
      expect(phone.engineProfile()).toMatchObject({ net: "big", workers: 1 });
      // lite 1 then big 1: no second heap is ever reserved on this device.
      expect(phone.createEngine.mock.calls.map(([o]) => o.net)).toEqual(["lite", "big"]);
    });
  });

  it("a fresh device gets one engine per Detect step, whatever its cores say", async () => {
    const phone = fixture({ device: () => PHONE, throughput: () => 1 });
    expect(await phone.detectEngineProfile()).toMatchObject({ net: "big", workers: 1 });
    // lite 1 then big 1 only: the ladder never tries a second heap on this device.
    expect(phone.createEngine.mock.calls.map(([o]) => o.net)).toEqual(["lite", "big"]);
  });

  it("a stored record cannot lift a device past what it can hold", () => {
    // A record written by another device's build (or edited by hand) is bounded
    // on read, so nothing starts three heaps on a device that can hold one.
    const phone = fixture({ device: () => PHONE });
    phone.data.set(PROFILE_KEY, JSON.stringify({
      profile: { net: "big", workers: 3, source: "user" }, detected: { net: "big", workers: 3, source: "detected" },
      measurements: null, probe: `3:${globalThis.__STOCKFISH__?.big?.id}`,
    }));
    const reloaded = createEngineProfileManager({ storage: () => phone.storage, device: () => PHONE,
      assetState: () => ({ phase: "ready" }) });
    expect(reloaded.engineProfile()).toMatchObject({ net: "big", workers: 1 });
    expect(reloaded.usableEngineProfile()).toMatchObject({ net: "big", workers: 1 });
  });

  it("the Settings controls cannot raise a phone past its bound either", () => {
    const phone = fixture({ device: () => PHONE });
    expect(phone.setEngineProfile({ net: "big", workers: 3 })).toMatchObject({ net: "big", workers: 1 });
    expect(phone.usableEngineProfile()).toMatchObject({ net: "big", workers: 1 });
  });
});
