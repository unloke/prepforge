// Device-local engine choice. This localStorage record is the only place a
// hardware-sized value lives — net, workers, the probe's result and its
// measurements describe the device that produced them, so they are never posted
// to the settings API and never arrive from another device. Each device therefore
// keeps its own setup: the store here, and the ladder that measured it. Depth and
// Maia strength are user settings; those sync through /api/settings.
import { loadEngineModule, EngineAssetError, engineAssetState, subscribeEngineAsset } from "./engine-assets.js";
import { stockfishBudget } from "./compute-budget.js";
export const PROFILE_KEY = "prepforge.engine-profile";
export const CRASH_KEY = "prepforge.engine-starting";
export const PROBE_NODES = 200000;
export function reserveEngineMemory(net, Memory = WebAssembly.Memory) {
  const { initialHeapPages: initial, maxHeapPages: maximum } = globalThis.__STOCKFISH__[net];
  return new Memory({ initial, maximum, shared: true });
}
const FALLBACK = { net: "lite", workers: 1, source: "fallback" };
const MAX_WORKERS = 3;
const valid = p => p && ["big", "lite"].includes(p.net) && Number.isInteger(p.workers) && p.workers >= 1 && p.workers <= MAX_WORKERS;
// What this device can hold, applied to any profile that is loaded or written.
const fitWorkers = (p, limit) => ({ ...p, workers: Math.min(p.workers, limit) });
// Workers this device completed on each net in its last Detect ({lite, big}).
const validProven = p => !!p && ["lite", "big"].every(net => Number.isInteger(p[net]) && p[net] >= 0 && p[net] <= MAX_WORKERS);

// Ladder order: each step adds one heap, so the count only ever grows.
// The step the device holds below a crashed one; lite x1 is the floor.
const LADDER = [["lite", 1], ["big", 1], ["big", 2], ["big", 3]];
export function stepDownProfile(p) {
  return p.net === "big" && p.workers > 1
    ? { net: "big", workers: p.workers - 1, source: "fallback" }
    : { net: "lite", workers: p.net === "big" ? 1 : Math.max(1, p.workers - 1), source: "fallback" };
}
// The workers each net held before `step`: every ladder step below it completed.
export function heldBelow({ net, workers }) {
  const held = { lite: 0, big: 0 };
  for (const [n, w] of LADDER) {
    if (n === net && w === workers) break;
    held[n] = Math.max(held[n], w);
  }
  return held;
}

// How many engines this device could HOLD. Every worker reserves its net's whole
// heap (384 MiB for big, 256 MiB for lite), so a memory signal bounds the count.
// deviceMemory is the only memory signal a browser exposes (Chromium); WebKit
// reports none, and "no signal" is not "assume small": the ceiling stays open and
// Detect proves each step by reserving that step's heap, stopping at the first
// step that fails or stops paying off. Cores bound the count on every device,
// because a probe cannot use more workers than the CPU can run.
export function maxWorkers({ hardwareConcurrency, deviceMemory } = {}) {
  const byMemory = deviceMemory > 0 ? (deviceMemory <= 2 ? 1 : deviceMemory <= 4 ? 2 : MAX_WORKERS) : MAX_WORKERS;
  const cores = hardwareConcurrency > 0 ? hardwareConcurrency : 1;
  return Math.max(1, Math.min(MAX_WORKERS, byMemory, cores));
}

// An extra worker is kept when it adds at least half of one worker's speed. Below that it
// mostly costs memory and heat (shared or efficiency cores, throttling).
export const MIN_GAIN = 0.5;
// One position for every round: speed differs by position, so a new one per round would skew the gain.
const FEN = "r1bq1rk1/ppp2ppp/2np1n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 4 6";
// A detected profile is measured on one build; a new engine build or probe is measured again.
const PROBE_ID = `4:${globalThis.__STOCKFISH__?.big?.id}`;

// Inject only browser boundaries for deterministic tests; production owns one manager.
export function createEngineProfileManager({
  storage = () => globalThis.localStorage,
  device = () => globalThis.navigator || {},
  now = () => performance.now(),
  probeId = PROBE_ID,
  probeBudget = opts => stockfishBudget.acquireProbe(opts),
  beginSession = () => stockfishBudget.beginSession(),
  reserveMemory = reserveEngineMemory,
  loadModule = loadEngineModule,
  assetState = engineAssetState,
  subscribeAsset = subscribeEngineAsset,
  page = globalThis.document,
  lifecycle = globalThis.window,
  createEngine = async opts => (await import("./stockfish-provider.js")).createStockfishWasmProvider({ ...opts, computeBudget: null, profileManaged: false }),
  scheduleIdle = fn => globalThis.requestIdleCallback ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 1000),
} = {}) {
  let loaded = false, broken = false, profile = FALLBACK, detected = null, measurements = null, proven = null;
  let probing = null, revision = 0, autoSetupDone = false;
  const listeners = new Set();
  const usableListeners = new Set(), setupListeners = new Set();
  let activeRuns = 0, heldUsable = null, publishPending = null, started = false, watching = false;
  let lastUsable = null;
  let setup = { phase: "idle", fraction: 0, loaded: 0, total: 0, stage: null, done: 0, probeTotal: 0, label: "" };
  function setupState(changes) {
    setup = { ...setup, ...changes };
    for (const fn of [...setupListeners]) { try { fn({ ...setup }); } catch { /* consumer error */ } }
  }
  function usable() {
    if (heldUsable) return { ...heldUsable };
    const p = current();
    return (p.source === "user" || detected) && assetState(p.net).phase === "ready" ? p : { ...FALLBACK };
  }
  function emitUsable() {
    if (activeRuns) return;
    const p = usable();
    const key = `${p.net}:${p.workers}`;
    if (key === lastUsable) return;
    lastUsable = key;
    for (const fn of [...usableListeners]) { try { fn(p); } catch { /* consumer error */ } }
  }
  function watchAssets() {
    if (watching) return;
    watching = true;
    for (const net of ["lite", "big"]) subscribeAsset(net, a => {
      if (["download", "compile", "error"].includes(a.phase)) {
        setupState({ phase: a.phase, loaded: a.loaded, total: a.total,
          fraction: a.total ? Math.min(1, a.loaded / a.total) : 0,
          label: a.phase === "download" ? `Downloading ${net === "big" ? "full" : "lite"} engine…`
            : a.phase === "compile" ? "Compiling engine…" : a.error.message });
      } else if (a.phase === "ready" && !probing) {
        setupState({ phase: "ready", fraction: 1, loaded: a.loaded, total: a.total, label: "Engine ready" });
      }
      emitUsable();
    });
  }
  function publishDetection(candidate, epoch) {
    const publish = () => {
      detected = candidate;
      if (epoch === revision) change(detected);
      else persist();
    };
    if (activeRuns) publishPending = publish;
    else publish();
  }
  const pending = new Map();
  let pageHidden = false;
  function syncCrashMark() {
    const entry = [...pending.values()].at(-1);
    access(s => {
      // A probe step is a deliberate heap reservation: it stays armed in a hidden
      // tab too, so an OOM kill there still tells the next load which step died.
      if (entry && (entry.sticky || (!pageHidden && page?.visibilityState !== "hidden"))) s.setItem(CRASH_KEY, JSON.stringify(entry.attempt));
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
    access(s => s.setItem(PROFILE_KEY, JSON.stringify({ profile, detected, measurements, proven, probe: probeId })));
  }
  function emit() {
    for (const fn of [...listeners]) { try { fn({ ...profile }); } catch { /* consumer error */ } }
    emitUsable();
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
      if (fresh && validProven(saved.proven)) proven = saved.proven;
      const crash = JSON.parse(s.getItem(CRASH_KEY) || "null");
      if (valid(crash)) {
        profile = stepDownProfile(crash);
        detected = profile;
        // The steps below the one that died completed; the one that died and
        // everything above it did not. Settings offers only the completed ones.
        proven = heldBelow(crash);
        s.setItem(PROFILE_KEY, JSON.stringify({ profile, detected, measurements, proven, probe: probeId }));
        s.removeItem(CRASH_KEY);
      }
    });
  }
  // The most engines this device has shown it can hold on each net; 0 means the
  // ladder never got as far as that net's first step. Before the first Detect only
  // a real signal bounds it. Lite x1 is the floor every device starts from.
  function choices() {
    load();
    const core = maxWorkers(device());
    if (!proven) return { lite: core, big: core };
    // A device that held n big heaps holds n lite heaps: the lite heap is smaller.
    return { lite: Math.min(core, Math.max(proven.lite, proven.big, 1)), big: Math.min(core, proven.big) };
  }
  // What this device can actually run: the measured net, or the signal bound before
  // its first Detect. A net the ladder never held is the one that failed.
  function current() {
    load();
    const limit = choices()[profile.net];
    return limit > 0 ? fitWorkers({ ...profile }, limit) : { ...FALLBACK };
  }
  function change(next) {
    const limit = choices()[next.net];
    // A net the ladder never held is not a choice: the device stays on the floor.
    next = limit > 0 ? fitWorkers(next, limit) : { ...FALLBACK };
    revision++;
    profile = next;
    persist();
    emit();
    return current();
  }
  // The ladder's own record: the workers each net held, so Settings can offer
  // exactly those.
  const recordProven = (run, net, workers) => { run[net] = Math.max(run[net] || 0, workers); };
  function failure(attempt) {
    load();
    if (profile.net !== attempt.net || profile.workers !== attempt.workers) return current();
    const next = stepDownProfile(attempt);
    if (next.net === profile.net && next.workers === profile.workers) return current();
    if (proven) {
      proven = { lite: 0, big: 0, ...proven };
      proven[next.net] = Math.min(proven[next.net] || 0, next.workers);
    }
    detected = next;
    return change(detected);
  }
  // A foreground run leaves evidence only while it owns engines. Background
  // eviction on iOS is not a crash; re-arm when a still-active run returns.
  // A probe step is different: it reserves a heap on purpose, so `sticky` keeps
  // its mark even while the page is hidden.
  function guard(attempt = current(), { sticky = false } = {}) {
    const token = {};
    if (!pending.size) {
      pageHidden = page?.visibilityState === "hidden";
      page?.addEventListener("visibilitychange", visibility);
      lifecycle?.addEventListener("pagehide", hide);
      lifecycle?.addEventListener("pageshow", visibility);
    }
    pending.set(token, { attempt, sticky });
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
    // The session owns this choice through the main pass and every Maia follow-up.
    let mark, attempt = usable(), retried = false, error = null, ended = false;
    heldUsable ||= attempt;
    activeRuns++;
    const endSession = beginSession();
    return {
      start() {
        if (error) throw error;
        if (!mark) mark = guard(attempt);
        return { ...attempt };
      },
      retry(failed) {
        if (!mark) { error ||= failed; return false; }
        const next = mark.fail();
        mark = null;
        const previous = stepDownProfile(attempt);
        if (retried || next.net !== attempt.net || next.source !== "fallback" || next.net !== previous.net || next.workers !== previous.workers ||
            (next.net === attempt.net && next.workers === attempt.workers)) {
          error = failed;
          return false;
        }
        retried = true;
        attempt = next;
        return true;
      },
      profile: () => ({ ...attempt }),
      get error() { return error; },
      done() {
        mark?.done(); mark = null;
        if (ended) return;
        ended = true;
        activeRuns--;
        if (!activeRuns) { heldUsable = null; const publish = publishPending; publishPending = null; publish?.(); emitUsable(); }
        endSession();
      },
    };
  }
  async function detect({ signal } = {}) {
    load();
    watchAssets();
    if (probing) return probing;
    if (broken) return { ...current(), measurements };
    const epoch = revision;
    probing = Promise.resolve().then(async () => {
      try {
        if (signal?.aborted) throw new DOMException("Detection stopped", "AbortError");
        // Asset preparation never occupies the idle compute window or a heap.
        const modules = await Promise.all([loadModule("lite"), loadModule("big")]);
        for (;;) {
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) controller.abort();
          let yielded = false;
          try {
            return await probeOnce(controller.signal, () => { yielded = true; controller.abort(); },
              { lite: modules[0], big: modules[1] }, epoch);
          } catch (error) {
            if (!yielded || signal?.aborted) throw error;
            setupState({ phase: "waiting", label: "Waiting for engine…" });
          } finally { signal?.removeEventListener("abort", abort); }
        }
      } catch (error) {
        setupState({ phase: error.name === "AbortError" ? "idle" : "error", label: error.name === "AbortError" ? "" : error.message });
        throw error;
      } finally { probing = null; }
    });
    return probing;
  }
  async function probeOnce(signal, onDemand, modules, epoch) {
    const abort = () => { if (signal?.aborted) throw new DOMException("Detection stopped", "AbortError"); };
    abort();
    // Steps in ladder order: each one learns the net's module plus two timed rounds.
    const steps = [["lite", 1]];
    for (let n = 1; n <= maxWorkers(device()); n++) steps.push(["big", n]);
    const units = steps.length * 3;
    let done = 0;
    const progress = (stage, step = 0, workers = null) => {
      done = stage === "complete" || stage === "fallback" ? units : Math.max(done, step);
      setupState({ phase: stage === "complete" || stage === "fallback" ? "ready" : "probe",
        stage, done, probeTotal: units, fraction: done / units,
        label: stage === "workers" ? `Trying ${workers} workers…` : stage === "loading" ? "Loading engine…"
          : stage === "speed" ? "Measuring speed…" : "Engine ready" });
    };
    const engines = [];
    let resume;
    let mark;
    let candidate = { ...FALLBACK };
    const hardware = device();
    measurements = { scaling: { lite: [], big: [] }, hardwareConcurrency: hardware.hardwareConcurrency ?? null,
      deviceMemory: hardware.deviceMemory ?? null };
    const held = { lite: 0, big: 0 };
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
      setupState({ phase: "waiting", fraction: 0, label: "Waiting for the engine…" });
      resume = await probeBudget({ signal, onDemand });
      abort();
      let step = 0;
      let net = null;
      for (const [nextNet, n] of steps) {
        if (nextNet !== net) {
          await close(); // Never hold both nets, even during big's reservation.
          net = nextNet;
          abort();
        }
        const wasmModule = modules[net];
        const scaling = measurements.scaling[net];
        abort();
        const attempt = { net, workers: n, source: "detected" };
        // Armed before the heap is reserved: if this step kills the tab, the next
        // load starts below it instead of retrying what died.
        mark = guard(attempt, { sticky: true });
        const stage = net === "lite" ? "loading" : n === 1 ? "speed" : "workers";
        progress(stage, step, n);
        const loadingAt = now();
        // Keep the existing workers alive while reserving the next heap, then
        // inject it: dropping a reservation would depend on GC before allocation.
        let wasmMemory = reserveMemory(net);
        const engine = await createEngine({ net, wasmModule, wasmMemory, maxDepth: 60, maxNodes: PROBE_NODES });
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
        mark = null;
        scaling.push(r.nodes * 1000 / r.ms);
        // Every completed step was held by this device, whether or not it wins:
        // Settings may offer it, and the faster one stays the chosen profile.
        recordProven(held, net, n);
        if (n > 1 && scaling[n - 1] - scaling[n - 2] < MIN_GAIN * scaling[0]) break;
        candidate = attempt;
        Object.assign(measurements, { nodes: r.nodes, searchMs: r.ms, loadMs, nodesPerSecond: scaling[n - 1] });
      }
      proven = held;
      abort();
      await close();
      abort();
      publishDetection(candidate, epoch);
      progress("complete");
      return { ...current(), measurements: { ...measurements } };
    } catch (error) {
      mark?.done();
      if (signal?.aborted || error.name === "AbortError") throw new DOMException("Detection stopped", "AbortError");
      if (error instanceof EngineAssetError) throw error;
      measurements = { ...measurements, error: error.message };
      // The steps that completed before this failure are what this device holds.
      proven = held;
      await close();
      abort();
      publishDetection(candidate, epoch);
      progress("fallback");
      return { ...current(), measurements: { ...measurements } };
    } finally {
      await close();
      resume?.();
      signal?.removeEventListener("abort", close);
    }
  }
  function prepareFull() {
    watchAssets();
    return loadModule("big");
  }
  // A return visit has the chosen net's bytes in Cache Storage: compiling them takes about a
  // second, so a run waits for that instead of starting on lite. A download is never waited for.
  async function readyIfCached() {
    load();
    const p = current();
    if (p.net !== "big" || !(p.source === "user" || detected) || device().connection?.saveData) return;
    const ready = prepareFull();
    let off = null;
    const phase = await Promise.race([
      new Promise(resolve => { off = subscribeAsset("big", a => { if (a.phase !== "idle") resolve(a.phase); }); }),
      ready.then(() => "ready", () => "error"),
    ]);
    off?.();
    if (phase === "compile" || phase === "ready") await ready.catch(() => {});
    else ready.catch(() => {});
  }
  // A device that has never set itself up runs Detect on its own, once, idle after
  // the first screen is up. A saved setup — detected, chosen by the user, or
  // recovered from a crash record — is a setup; nothing runs again unasked.
  function autoSetup() {
    if (autoSetupDone) return;
    autoSetupDone = true;
    load();
    if (broken || detected || profile.source !== "fallback") return;
    if (device().connection?.saveData) return;
    scheduleIdle(() => {
      if (detected || profile.source !== "fallback" || probing) return;
      void detect().catch(() => {});
    });
  }
  return {
    engineProfile: current,
    usableEngineProfile: usable,
    engineSetupState: () => ({ ...setup }),
    subscribeEngineSetup(fn) { watchAssets(); setupListeners.add(fn); fn({ ...setup }); return () => setupListeners.delete(fn); },
    subscribeUsableEngineProfile(fn) { watchAssets(); lastUsable ??= `${usable().net}:${usable().workers}`; usableListeners.add(fn); return () => usableListeners.delete(fn); },
    prepareFullEngine: prepareFull,
    readyIfCached,
    engineStarted() {
      if (started) return;
      started = true;
      load();
      if (device().connection?.saveData || broken || (detected?.net === "lite" && profile.source !== "user")) return;
      void prepareFull().then(() => {
        if (!detected && profile.source !== "user") return detect();
      }).catch(() => {});
    },
    engineMeasurements() { load(); return measurements ? { ...measurements } : null; },
    // The workers each net can use on this device; Settings disables the rest.
    engineWorkerChoices: choices,
    // A device with no setup of its own sets itself up; see autoSetup.
    setupOnFirstVisit: autoSetup,
    setEngineProfile(p) { load(); if (!valid(p)) throw new RangeError("Choose big/lite and 1–3 workers"); return change({ net: p.net, workers: p.workers, source: "user" }); },
    resetEngineProfile() { load(); return change(detected || { ...FALLBACK }); },
    detectEngineProfile: detect,
    subscribeEngineProfile(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    guardEngineStartup: guard,
    reportEngineFailure: failure,
    createEngineAnalysisRun: createAnalysisRun,
  };
}

const manager = createEngineProfileManager();
export const { engineProfile, engineMeasurements, engineWorkerChoices, setupOnFirstVisit, setEngineProfile, resetEngineProfile, detectEngineProfile,
  usableEngineProfile, subscribeUsableEngineProfile, engineSetupState, subscribeEngineSetup, prepareFullEngine, engineStarted,
  readyIfCached,
  subscribeEngineProfile, guardEngineStartup, reportEngineFailure, createEngineAnalysisRun } = manager;
stockfishBudget.configure(usableEngineProfile().workers);
subscribeUsableEngineProfile(p => stockfishBudget.configure(p.workers));
