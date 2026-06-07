// Maia3 provider — the MAIN-THREAD front for the browser Maia3 engine
// (docs/browser-engine-migration.md Phase 3b). It owns the worker lifecycle, resolves
// the asset base on the main thread (the worker can't see window.__MAIA3_ASSET_BASE),
// correlates concurrent requests by id, and implements the failure/recovery contract:
// a single request error rejects only its Promise; a worker crash or init failure makes
// the provider unavailable but re-inits on the next call.
//
// Deliberately imports NO onnxruntime-web here — only the worker does — so the provider
// (and its request/recovery logic) is unit-testable in node against a fake worker.
import { assertManifestContract } from "./maia3-tokenizer.js";

// The manifest is small and ships in-image; the .onnx weights are CDN/object-store
// hosted and resolved at runtime (see resolveModelBase / the migration doc).
const MANIFEST_URL = "/static/maia3/maia3.manifest.json";
const DEFAULT_RATING = 1500;
// Init has to download + sha256-verify the artifact (fp16 ~46 MB) and create the ORT
// session, so the bound is generous — it's a HANG detector, not an SLA. Without it a
// stuck fetch or a wedged backend (the observed WebGPU-in-worker >2 min hang) leaves
// _request("init") pending forever and the UI stuck on "loading". On timeout we tear
// the worker down and clear the cached promise so the next call re-inits cleanly.
const DEFAULT_INIT_TIMEOUT_MS = 120000;

// Resolve the weight base URL at RUNTIME (no rebuild / no Node at deploy). First match
// wins: injected global (the production knob the server renders into the page) →
// manifest.asset_base → build-time Vite var → in-image /static/maia3/ (local dev). This
// MUST run on the main thread: a worker's globalThis can't see window.__MAIA3_ASSET_BASE.
export function resolveModelBase(manifest) {
  const fromGlobal =
    typeof globalThis !== "undefined" ? globalThis.__MAIA3_ASSET_BASE : undefined;
  const base =
    fromGlobal ||
    (manifest && manifest.asset_base) ||
    (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_MAIA3_ASSET_BASE) ||
    "/static/maia3/";
  return String(base).replace(/\/?$/, "/");
}

// Default backend EP. The single-threaded smoke found WASM beats WebGPU decisively at
// batch=1 (WebGPU pays a ~3.5s shader-compile + is slower warm), so default to WASM
// even when WebGPU is available; callers can override via the `backend` option once
// batched WebGPU is benchmarked.
function defaultBackend() {
  return "wasm";
}

// Conservative ceiling on ORT WASM worker threads (Stage 4c). The Maia worker shares the
// machine with the Stockfish widget's own threads and ORT's batch=1 throughput gains
// plateau quickly, so we don't fan out to every core.
export const MAX_WASM_THREADS = 4;

// Resolve the ORT WASM thread count on the MAIN thread (the provider knows the page's
// capabilities; the worker just applies the number). Threaded WASM uses SharedArrayBuffer,
// which only exists under cross-origin isolation (COOP/COEP) — so WITHOUT it we MUST stay
// single-threaded or session creation would fail trying to allocate a SAB. With it, honour
// an explicit `requested` override, else pick min(cores, MAX_WASM_THREADS).
export function resolveThreadCount({ crossOriginIsolated, hardwareConcurrency, requested } = {}) {
  if (!crossOriginIsolated) return 1;
  if (Number.isInteger(requested) && requested >= 1) {
    return Math.min(requested, MAX_WASM_THREADS);
  }
  const cores = Number.isInteger(hardwareConcurrency) && hardwareConcurrency >= 1 ? hardwareConcurrency : 1;
  return Math.max(1, Math.min(cores, MAX_WASM_THREADS));
}

// Read the live page capabilities for resolveThreadCount (split out so it's stubbable).
function pageThreadCount(requested) {
  return resolveThreadCount({
    crossOriginIsolated: typeof globalThis !== "undefined" ? !!globalThis.crossOriginIsolated : false,
    hardwareConcurrency: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 1,
    requested,
  });
}

function defaultCreateWorker() {
  return new Worker(new URL("./maia3-worker.js", import.meta.url), { type: "module" });
}

export function createMaia3Provider(options = {}) {
  return new Maia3Provider(options);
}

// A process-wide shared provider so repeated Build Generate runs reuse ONE warm worker +
// ORT session instead of downloading + re-creating the ~46 MB model every call (Stage 4b).
// The provider self-heals (a crash/timeout clears its cached init promise and re-inits on
// the next call), so the singleton stays valid across runs; the IndexedDB weight cache
// makes even a cold re-init skip the network. Callers MUST treat it as borrowed — do not
// terminate it (use disposeSharedMaia3Provider for an explicit model switch / teardown).
let sharedProvider = null;

export function getSharedMaia3Provider(options = {}) {
  if (!sharedProvider) sharedProvider = new Maia3Provider(options);
  return sharedProvider;
}

export function disposeSharedMaia3Provider() {
  if (sharedProvider) {
    sharedProvider.terminate();
    sharedProvider = null;
  }
}

class Maia3Provider {
  constructor({
    createWorker = defaultCreateWorker,
    manifest = null,
    assetBase = null,
    backend = null,
    manifestUrl = MANIFEST_URL,
    defaultRating = DEFAULT_RATING,
    initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS,
    onInitProgress = null,
    numThreads = null,
  } = {}) {
    this._createWorker = createWorker;
    this._manifestOption = manifest;
    this._assetBaseOption = assetBase;
    this._backendOption = backend;
    this._manifestUrl = manifestUrl;
    this._defaultRating = defaultRating;
    this._initTimeoutMs = initTimeoutMs;
    this._onInitProgress = typeof onInitProgress === "function" ? onInitProgress : null;
    // Explicit ORT WASM thread override (null → auto from page capabilities at init).
    this._numThreadsOption = Number.isInteger(numThreads) && numThreads >= 1 ? numThreads : null;

    this._worker = null;
    this._ready = null; // cached init promise; cleared on failure so init can retry
    this._pending = new Map(); // request id → { resolve, reject }
    this._nextId = 1;
    this._state = "idle"; // idle | initializing | ready | unavailable
    this._assetBase = null; // resolved weight base (main-thread) — observable for the seam check
    this._info = null; // last successful worker init result ({ backend, file, bytes, url, cached })
    // The most recent failure that made the provider unavailable. Settings surfaces this so
    // "unavailable" is diagnosable instead of a fixed string; cleared on a successful init.
    // Shape: { message, phase, at } where phase is "init" (incl. timeout + worker-reported
    // ORT/weight-fetch errors, which reject the init request) or "crash" (worker died).
    this._lastError = null;
  }

  // Set (or clear with null) the init-progress handler. Called with
  // { phase: "cache"|"download"|"verify"|"session", loaded, total } during a cold init;
  // a warm (already-ready) provider emits nothing. Settable so a long-lived/shared provider
  // can route progress to whichever caller is currently waiting on it.
  setInitProgressHandler(fn) {
    this._onInitProgress = typeof fn === "function" ? fn : null;
  }

  get state() {
    return this._state;
  }

  isAvailable() {
    return this._state === "ready";
  }

  // The weight base resolved on the main thread (window.__MAIA3_ASSET_BASE → manifest →
  // build var → local). Set once init starts; exposed so the live harness can assert the
  // cross-origin CDN seam.
  get assetBase() {
    return this._assetBase;
  }

  // The worker's last successful init result, incl. the URL the .onnx was fetched from —
  // the only observable proof of WHICH origin served the weights.
  get info() {
    return this._info;
  }

  // The most recent failure ({ message, phase, at }), or null if init last succeeded.
  // Exposed so Settings can show WHY Maia is unavailable (timeout vs crash vs ORT/fetch
  // error) rather than a fixed "it'll retry" line.
  get lastError() {
    return this._lastError;
  }

  // predictions({ fen, historyFens?, rating }) → [{ move_uci, probability, rank }].
  // [] for a terminal position (checkmate/stalemate). historyFens accepted but ignored
  // (bare-FEN parity).
  async predictions({ fen, historyFens, rating } = {}) {
    void historyFens;
    await this._ensureReady();
    return this._request("predictions", { fen, rating: rating ?? this._defaultRating });
  }

  // moveAssessment({ fen, moveUci, historyFens?, rating }) →
  // { humanProbability, winChanceAfter } | null (malformed FEN or illegal move).
  async moveAssessment({ fen, moveUci, historyFens, rating } = {}) {
    void historyFens;
    await this._ensureReady();
    return this._request("moveAssessment", { fen, moveUci, rating: rating ?? this._defaultRating });
  }

  // moveAssessmentBatch({ fen, moves, historyFens?, rating }) → array aligned to `moves`
  // (null in each malformed/illegal slot); one padded value forward.
  async moveAssessmentBatch({ fen, moves, historyFens, rating } = {}) {
    void historyFens;
    await this._ensureReady();
    return this._request("moveAssessmentBatch", {
      fen,
      moves: moves || [],
      rating: rating ?? this._defaultRating,
    });
  }

  // Tear down for good (e.g. page navigation / model switch). Rejects anything pending.
  terminate() {
    this._teardownWorker();
    this._failAllPending(new Error("Maia3 provider terminated"));
    this._ready = null;
    this._state = "idle";
    this._lastError = null;
  }

  // ---- internals ------------------------------------------------------------

  _ensureReady() {
    if (this._ready) return this._ready;
    this._state = "initializing";
    this._ready = this._init().then(
      (value) => {
        this._state = "ready";
        this._lastError = null; // a clean init clears any prior failure
        return value;
      },
      (err) => {
        // Init failed (incl. timeout): tear the worker down, reject any request still
        // pending (the init request itself when we timed out — no reply ever came), and
        // clear the cached promise so the NEXT call re-attempts on a fresh worker (init is
        // retryable, not a permanent wedge). Remember WHY so Settings can show it.
        this._teardownWorker();
        this._failAllPending(err);
        this._ready = null;
        this._state = "unavailable";
        this._recordError(err, "init");
        throw err;
      },
    );
    return this._ready;
  }

  async _init() {
    const manifest =
      this._manifestOption || (await (await fetch(this._manifestUrl)).json());
    // Fail fast if the manifest's layout no longer matches the tokenizer's contract.
    assertManifestContract(manifest);
    const assetBase = this._assetBaseOption || resolveModelBase(manifest);
    this._assetBase = assetBase;
    const backend = this._backendOption || defaultBackend();
    // Resolve threads on the MAIN thread (page capabilities); the worker only applies it.
    // Only WASM uses ORT's thread pool — WebGPU runs on the GPU, so force 1 there.
    const numThreads = backend === "wasm" ? pageThreadCount(this._numThreadsOption) : 1;

    const worker = this._createWorker();
    this._worker = worker;
    worker.onmessage = (ev) => this._onMessage(ev.data);
    worker.onerror = (ev) => this._onWorkerCrash(ev);
    worker.onmessageerror = (ev) => this._onWorkerCrash(ev);

    // init is itself a correlated request; the worker downloads + sha256-verifies the
    // artifact and creates the session, replying ok/err with this id. Bound it: a stuck
    // download or a wedged backend would otherwise leave this Promise pending forever.
    const info = await this._withInitTimeout(
      this._request("init", {
        assetBase,
        manifest,
        backend,
        numThreads,
        defaultRating: this._defaultRating,
      }),
    );
    this._info = info;
    return info;
  }

  // Race the init request against a timeout. On timeout reject with a clear error; the
  // _ensureReady rejection path then tears the worker down, fails any pending request,
  // and clears the cached promise so the NEXT call re-inits on a fresh worker.
  _withInitTimeout(promise) {
    if (!this._initTimeoutMs || this._initTimeoutMs <= 0) return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Maia3 init timed out after ${this._initTimeoutMs}ms ` +
              `(worker never finished the weight fetch / session create)`,
          ),
        );
      }, this._initTimeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  _request(type, payload) {
    return new Promise((resolve, reject) => {
      if (!this._worker || this._state === "unavailable") {
        reject(new Error(`Maia3 provider unavailable (state=${this._state})`));
        return;
      }
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      try {
        this._worker.postMessage({ id, type, ...payload });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  _onMessage(msg) {
    if (!msg || typeof msg.id !== "number") return;
    // Progress notifications (during init weight download/verify/session) are NOT replies:
    // they carry the request id but must not settle or delete the pending entry. Only route
    // them while that id is still pending, so a late progress message after teardown/timeout
    // can't fire the handler.
    if (msg.progress) {
      if (this._onInitProgress && this._pending.has(msg.id)) {
        this._onInitProgress({ phase: msg.phase, loaded: msg.loaded, total: msg.total });
      }
      return;
    }
    const entry = this._pending.get(msg.id);
    if (!entry) return; // unknown / already-settled id
    this._pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || "Maia3 worker request failed"));
  }

  _onWorkerCrash(ev) {
    const reason = (ev && (ev.message || ev.type)) || "worker crashed";
    this._state = "unavailable";
    this._teardownWorker();
    this._ready = null; // allow re-init on the next call
    const err = new Error(`Maia3 worker crashed: ${reason}`);
    this._recordError(err, "crash");
    this._failAllPending(err);
  }

  // Capture a failure for Settings to surface. Best-effort and never throws.
  _recordError(err, phase) {
    this._lastError = {
      message: (err && err.message) || String(err) || "unknown error",
      phase,
      at: Date.now(),
    };
  }

  _teardownWorker() {
    if (this._worker) {
      try {
        this._worker.onmessage = null;
        this._worker.onerror = null;
        this._worker.onmessageerror = null;
        this._worker.terminate();
      } catch {
        // best effort
      }
    }
    this._worker = null;
  }

  _failAllPending(err) {
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
  }
}
