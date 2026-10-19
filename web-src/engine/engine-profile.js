// Device-local engine choice. Depth remains a synced account setting.
export const PROFILE_KEY = "prepforge.engine-profile";
export const CRASH_KEY = "prepforge.engine-starting";
export const PROBE_NODES = 200000;
export function reserveEngineMemory(net, Memory = WebAssembly.Memory) {
  const { initialHeapPages: initial, maxHeapPages: maximum } = globalThis.__STOCKFISH__[net];
  return new Memory({ initial, maximum, shared: true });
}
const FALLBACK = { net: "lite", workers: 1, source: "fallback" };
const valid = p => p && ["big", "lite"].includes(p.net) && Number.isInteger(p.workers) && p.workers >= 1 && p.workers <= 3;

// A crash at big 1 means even one big heap does not fit, so drop to the smallest lite pool.
export function stepDownProfile(p) {
  return p.net === "big" && p.workers > 1
    ? { net: "big", workers: p.workers - 1, source: "fallback" }
    : { net: "lite", workers: p.net === "big" ? 1 : Math.max(1, p.workers - 1), source: "fallback" };
}

// Upper bound on the workers worth trying. Cores and deviceMemory (Chromium only) say what
// cannot work, not what does: the probe measures whether each extra worker adds throughput.
export function maxWorkers({ hardwareConcurrency, deviceMemory } = {}) {
  let n = Math.min(3, hardwareConcurrency > 0 ? hardwareConcurrency : 3);
  if (deviceMemory > 0) n = Math.min(n, deviceMemory <= 2 ? 1 : deviceMemory <= 4 ? 2 : 3);
  return n;
}

// An extra worker is kept when it adds at least half of one worker's speed. Below that it
// mostly costs memory and heat (shared or efficiency cores, throttling).
export const MIN_GAIN = 0.5;
// One position for every round: speed differs by position, so a new one per round would skew the gain.
const FEN = "r1bq1rk1/ppp2ppp/2np1n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 4 6";
// A detected profile is measured on one build; a new engine build or probe is measured again.
const PROBE_ID = `3:${globalThis.__STOCKFISH__?.big?.id}`;

// Inject only browser boundaries for deterministic tests; production owns one manager.
export function createEngineProfileManager({
  storage = () => globalThis.localStorage,
  device = () => globalThis.navigator || {},
  now = () => performance.now(),
  probeId = PROBE_ID,
  probeBudget = async () => (await import("./compute-budget.js")).stockfishBudget.suspend(),
  reserveMemory = reserveEngineMemory,
  page = globalThis.document,
  lifecycle = globalThis.window,
  createEngine = async opts => (await import("./stockfish-provider.js")).createStockfishWasmProvider({ ...opts, computeBudget: null, profileManaged: false }),
} = {}) {
  let loaded = false, broken = false, profile = FALLBACK, detected = null, measurements = null;
  let probing = null, revision = 0;
  const listeners = new Set();
  const pending = new Map();
  let pageHidden = false;
  function syncCrashMark() {
    const attempt = [...pending.values()].at(-1);
    access(s => {
      if (attempt && !pageHidden && page?.visibilityState !== "hidden") s.setItem(CRASH_KEY, JSON.stringify(attempt));
      else s.removeItem(CRASH_KEY);
    });
  }
  const visibility = () => { pageHidden = page?.visibilityState === "hidden"; syncCrashMark(); };
  const hide = () => { pageHidden = true; syncCrashMark(); };
  function access(fn) {
    try { return fn(storage()); } catch {
      const changed = profile.net !== FALLBACK.net || profile.workers !== FALLBACK.workers;
      broken = true;
      profile = { ...FALLBACK };
      if (changed) emit();
      return null;
    }
  }
  function persist() {
    access(s => s.setItem(PROFILE_KEY, JSON.stringify({ profile, detected, measurements, probe: probeId })));
  }
  function emit() {
    for (const fn of [...listeners]) { try { fn({ ...profile }); } catch { /* consumer error */ } }
  }
  function load() {
    if (loaded) return;
    loaded = true;
    access(s => {
      const saved = JSON.parse(s.getItem(PROFILE_KEY) || "null");
      const fresh = saved?.probe === probeId;
      if (valid(saved?.profile) && (saved.profile.source === "user" || fresh)) profile = saved.profile;
      if (fresh && valid(saved.detected)) detected = saved.detected;
      if (fresh) measurements = saved.measurements || null;
      const crash = JSON.parse(s.getItem(CRASH_KEY) || "null");
      if (valid(crash)) {
        profile = stepDownProfile(crash);
        detected = profile;
        s.setItem(PROFILE_KEY, JSON.stringify({ profile, detected, measurements, probe: probeId }));
        s.removeItem(CRASH_KEY);
      }
    });
  }
  function current() { load(); return { ...profile }; }
  function change(next) {
    revision++;
    profile = next;
    persist();
    emit();
    return current();
  }
  function failure(attempt) {
    load();
    if (profile.net !== attempt.net || profile.workers !== attempt.workers) return current();
    const next = stepDownProfile(attempt);
    if (next.net === profile.net && next.workers === profile.workers) return current();
    detected = next;
    return change(detected);
  }
  // A foreground run leaves evidence only while it owns engines. Background
  // eviction on iOS is not a crash; re-arm when a still-active run returns.
  function guard(attempt = current()) {
    const token = {};
    if (!pending.size) {
      pageHidden = page?.visibilityState === "hidden";
      page?.addEventListener("visibilitychange", visibility);
      lifecycle?.addEventListener("pagehide", hide);
      lifecycle?.addEventListener("pageshow", visibility);
    }
    pending.set(token, attempt);
    syncCrashMark();
    function done() {
      if (!pending.has(token)) return;
      pending.delete(token);
      if (!pending.size) {
        page?.removeEventListener("visibilitychange", visibility);
        lifecycle?.removeEventListener("pagehide", hide);
        lifecycle?.removeEventListener("pageshow", visibility);
      }
      syncCrashMark();
    }
    return { done, fail() { done(); return failure(attempt); } };
  }
  function createAnalysisRun() {
    let mark, attempt, retried = false, error = null;
    return {
      start() {
        if (!mark) { attempt = current(); mark = guard(attempt); }
        return { ...attempt };
      },
      retry(failed) {
        const next = mark.fail();
        mark = null;
        const previous = stepDownProfile(attempt);
        if (retried || next.source !== "fallback" || next.net !== previous.net || next.workers !== previous.workers ||
            (next.net === attempt.net && next.workers === attempt.workers)) {
          error = failed;
          return false;
        }
        retried = true;
        return true;
      },
      profile: () => ({ ...attempt }),
      get error() { return error; },
      done() { mark?.done(); mark = null; },
    };
  }
  // Every caller of a running probe sees its progress, including one that joins late.
  const watchers = new Set();
  let lastProgress = null;
  async function detect({ signal, onProgress } = {}) {
    load();
    if (onProgress) {
      watchers.add(onProgress);
      if (probing && lastProgress) onProgress(lastProgress);
    }
    if (probing) return probing.finally(() => watchers.delete(onProgress));
    if (broken) return { ...current(), measurements };
    const epoch = revision;
    const abort = () => { if (signal?.aborted) throw new DOMException("Detection stopped", "AbortError"); };
    abort();
    // Steps: lite 1, then big 1..max; each is a load and two timed rounds.
    const units = (1 + maxWorkers(device())) * 3;
    let done = 0;
    const progress = (stage, step = 0, workers = null) => {
      done = stage === "complete" || stage === "fallback" ? units : Math.max(done, step);
      lastProgress = { stage, done, total: units, workers };
      for (const fn of [...watchers]) { try { fn(lastProgress); } catch { /* consumer error */ } }
    };
    probing = (async () => {
      const engines = [];
      let resume;
      let mark;
      let candidate = { ...FALLBACK };
      const hardware = device();
      measurements = { scaling: { lite: [], big: [] }, hardwareConcurrency: hardware.hardwareConcurrency ?? null,
        deviceMemory: hardware.deviceMemory ?? null };
      // Every engine searches the same node budget at once; throughput = total nodes / wall time.
      async function round() {
        const start = now();
        const done = await Promise.all(engines.map(async engine => {
          // A fresh hash for every engine, every round: a warm table would favour the old workers.
          await engine.open({ fen: FEN, depth: 60, multipv: 1, newGame: true });
          return engine.waitForSearchComplete({ targetDepth: 60, timeoutMs: 15000, cancelled: () => signal?.aborted, acceptShallowOnTimeout: false });
        }));
        const nodes = done.reduce((sum, s) => sum + (s.nodes || 0), 0);
        if (!(nodes > 0)) throw new Error("Device probe returned no nodes");
        return { nodes, ms: Math.max(1, now() - start) };
      }
      const close = () => Promise.all(engines.splice(0).map(e => e.close()));
      signal?.addEventListener("abort", close, { once: true });
      try {
        abort();
        resume = await probeBudget();
        abort();
        let step = 0;
        for (const net of ["lite", "big"]) {
          await close(); // Never hold both nets, even during big's reservation.
          const scaling = measurements.scaling[net];
          for (let n = 1; n <= (net === "lite" ? 1 : maxWorkers(hardware)); n++) {
            abort();
            const attempt = { net, workers: n, source: "detected" };
            mark = guard(attempt);
            const stage = net === "lite" ? "loading" : n === 1 ? "speed" : "workers";
            progress(stage, step, n);
            const loadingAt = now();
            // Keep the existing workers alive while reserving the next heap, then
            // inject it: dropping a reservation would depend on GC before allocation.
            let wasmMemory = reserveMemory(net);
            const engine = await createEngine({ net, wasmMemory, maxDepth: 60, maxNodes: PROBE_NODES });
            wasmMemory = null;
            engines.push(engine);
            abort();
            await engine.prepare();
            const loadMs = now() - loadingAt;
            abort();
            // Faster of two rounds: a fresh module's first search runs on baseline code while
            // the optimizing tier compiles (big 1 read 289k nodes/s, then 370-418k), and one
            // round alone swung big 3 between 817k and 1103k.
            progress(stage, step + 1, n);
            const first = await round();
            abort();
            progress(stage, step + 2, n);
            const second = await round();
            step += 3;
            const r = first.nodes / first.ms > second.nodes / second.ms ? first : second;
            abort();
            mark.done();
            scaling.push(r.nodes * 1000 / r.ms);
            if (n > 1 && scaling[n - 1] - scaling[n - 2] < MIN_GAIN * scaling[0]) break;
            candidate = attempt;
            Object.assign(measurements, { nodes: r.nodes, searchMs: r.ms, loadMs, nodesPerSecond: scaling[n - 1] });
          }
        }
        abort();
        detected = candidate;
        if (epoch === revision) change(detected);
        else persist();
        progress("complete");
        return { ...current(), measurements: { ...measurements } };
      } catch (error) {
        mark?.done();
        if (signal?.aborted || error.name === "AbortError") throw new DOMException("Detection stopped", "AbortError");
        detected = candidate;
        measurements = { ...measurements, error: error.message };
        if (epoch === revision) change(detected);
        else persist();
        progress("fallback");
        return { ...current(), measurements: { ...measurements } };
      } finally {
        await close();
        resume?.();
        signal?.removeEventListener("abort", close);
        watchers.delete(onProgress);
        lastProgress = null;
        probing = null;
      }
    })();
    return probing;
  }
  return {
    engineProfile: current,
    engineMeasurements() { load(); return measurements ? { ...measurements } : null; },
    setEngineProfile(p) { load(); if (!valid(p)) throw new RangeError("Choose big/lite and 1–3 workers"); return change({ net: p.net, workers: p.workers, source: "user" }); },
    resetEngineProfile() { load(); return change(detected || { ...FALLBACK }); },
    detectEngineProfile: detect,
    ensureEngineProfile(opts) { load(); return profile.source === "fallback" && !detected && !broken ? detect(opts) : Promise.resolve(current()); },
    subscribeEngineProfile(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    guardEngineStartup: guard,
    reportEngineFailure: failure,
    createEngineAnalysisRun: createAnalysisRun,
  };
}

const manager = createEngineProfileManager();
export const { engineProfile, engineMeasurements, setEngineProfile, resetEngineProfile, detectEngineProfile,
  ensureEngineProfile, subscribeEngineProfile, guardEngineStartup, reportEngineFailure, createEngineAnalysisRun } = manager;
