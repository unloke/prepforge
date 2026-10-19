import { describe, it, expect, vi } from "vitest";
import { createEngineProfileManager, reserveEngineMemory, stepDownProfile, PROFILE_KEY, CRASH_KEY, PROBE_NODES, maxWorkers } from "./engine-profile.js";

const STEPS = [["lite", 1], ["big", 1], ["big", 2], ["big", 3]];
function fixture({ throughput = (_net, n) => n, Memory = class { constructor(options) { this.options = options; } },
  prepare, search, ...options } = {}) {
  const data = new Map();
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  const engines = [];
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
  const manager = createEngineProfileManager({ storage: () => storage, createEngine, reserveMemory,
    probeBudget: async () => () => {}, device: () => ({ hardwareConcurrency: 4 }), now: () => (t += 1000), ...options });
  return { ...manager, data, storage, engines, createEngine, reserveMemory };
}

describe("device engine profile", () => {
  it("persists and validates a user choice, notifies and unsubscribes", () => {
    const f = fixture();
    expect(f.engineProfile()).toEqual({ net: "lite", workers: 1, source: "fallback" });
    const listener = vi.fn();
    const unsubscribe = f.subscribeEngineProfile(listener);
    f.setEngineProfile({ net: "big", workers: 2 });
    expect(f.engineProfile()).toEqual({ net: "big", workers: 2, source: "user" });
    expect(createEngineProfileManager({ storage: () => f.storage }).engineProfile()).toEqual(f.engineProfile());
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

  it.each([1.49, 1.5])("compares extra worker gain with the net's one-worker baseline (%s)", async gain => {
    const f = fixture({ device: () => ({ hardwareConcurrency: 2 }), throughput: (_net, n) => n === 1 ? 1 : gain });
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
      const nextLoad = createEngineProfileManager({ storage: () => f.storage, createEngine: () => { throw new Error("must not probe"); } });
      expect(nextLoad.engineProfile()).toEqual({ net: previous[0], workers: previous[1], source: "fallback" });
      return nextLoad.ensureEngineProfile();
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
    const run = f.detectEngineProfile({ onProgress: p => first.push(p) });
    await Promise.resolve();
    const joined = f.detectEngineProfile({ onProgress: p => late.push(p) });
    await Promise.all([run, joined]);
    const total = (1 + maxWorkers({ hardwareConcurrency: 4 })) * 3;
    expect(first.map(p => p.done)).toEqual([...first.map(p => p.done)].sort((a, b) => a - b));
    expect(first.at(-1)).toMatchObject({ stage: "complete", done: total, total });
    expect(first.some(p => p.stage === "workers" && p.workers === 2)).toBe(true);
    expect(late.at(-1)).toMatchObject({ stage: "complete", done: total });
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
    const rebuilt = createEngineProfileManager({ storage: () => f.storage, probeId: "new" });
    expect(rebuilt.engineProfile()).toMatchObject({ source: "fallback" });
    expect(rebuilt.engineMeasurements()).toBeNull();
    f.setEngineProfile({ net: "lite", workers: 2 });
    expect(createEngineProfileManager({ storage: () => f.storage, probeId: "new" }).engineProfile())
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
    expect(createEngineProfileManager({ storage: () => f.storage }).engineProfile()).toMatchObject({ net: "big", workers: 2 });
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
  });
});
