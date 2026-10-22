// What this browser holds of the two optional local engines, the full Stockfish
// net and the Maia 3 model, and the one way to fetch or drop each. Settings, the
// inline unlock rows and the welcome dialog all read this store, so a download
// started in one place shows its progress in every other.
import { engineAssetState, subscribeEngineAsset, isEngineAssetCached, loadEngineModule, removeEngineAsset } from "./engine-assets.js";
import { fullEngineFits, chooseFullEngine, detectEngineProfile } from "./engine-profile.js";
import { loadMaia3Manifest, peekSharedMaia3Provider, getSharedMaia3Provider, disposeSharedMaia3Provider, watchSharedMaia3Provider } from "./maia3-provider.js";
import { hasCachedWeights, clearWeightCache } from "./maia3-weight-cache.js";
import { maiaErrorText } from "../maia-init-notice.js";

export const ENGINE_IDS = ["stockfish", "maia"];

// Decimal megabytes, the unit every size in the app is quoted in.
export function formatMB(bytes) {
  return `${Math.max(1, Math.round((bytes || 0) / 1e6))} MB`;
}

const build = () => globalThis.__STOCKFISH__?.big || { bytes: 0, packageVersion: "" };
const MAIA_FALLBACK_BYTES = 46_417_576;
const NOT_KEPT = "Loaded for this visit only: there was no room to keep it.";

// A reason the download cannot start, already in the user's words.
class DownloadBlocked extends Error {}

export function createEngineDownloads({
  assetState = engineAssetState,
  subscribeAsset = subscribeEngineAsset,
  assetCached = isEngineAssetCached,
  loadModule = loadEngineModule,
  removeAsset = removeEngineAsset,
  fits = fullEngineFits,
  chooseFull = chooseFullEngine,
  detect = detectEngineProfile,
  manifest = loadMaia3Manifest,
  peekMaia = peekSharedMaia3Provider,
  getMaia = getSharedMaia3Provider,
  disposeMaia = disposeSharedMaia3Provider,
  watchMaia = watchSharedMaia3Provider,
  weightsCached = hasCachedWeights,
  clearWeights = clearWeightCache,
  navigator: nav = () => globalThis.navigator,
  later = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  const facts = {
    stockfish: { cached: null, busy: false, error: null, note: null },
    maia: { cached: null, busy: false, error: null, note: null, progress: null, bytes: MAIA_FALLBACK_BYTES, key: null },
  };
  const listeners = new Set();
  let started = false;
  let watchedProvider = null;
  let stopProgress = null;

  const emit = () => {
    for (const fn of [...listeners]) { try { fn(); } catch { /* a listener cannot break the store */ } }
  };

  function stockfishState() {
    const f = facts.stockfish;
    const a = assetState("big");
    const base = { id: "stockfish", bytes: build().bytes, version: `v${String(build().packageVersion || "").split(".")[0]}` };
    if (a.phase === "download") return { ...base, phase: "downloading", fraction: a.total ? Math.min(1, a.loaded / a.total) : null };
    if (a.phase === "compile") return f.busy ? { ...base, phase: "downloading", fraction: 1 } : { ...base, phase: "ready", note: f.note };
    if (a.phase === "ready" || f.cached) return { ...base, phase: "ready", note: f.note };
    if (f.busy) return { ...base, phase: "downloading", fraction: null };
    if (f.error || a.phase === "error") return { ...base, phase: "error", error: f.error || errorText("stockfish", a.error) };
    if (fits() === false) return { ...base, phase: "unsupported" };
    return { ...base, phase: f.cached === null ? "checking" : "absent" };
  }

  function maiaState() {
    const f = facts.maia;
    const p = peekMaia();
    const base = { id: "maia", bytes: f.bytes, version: "v3" };
    if (p?.state === "ready" || (f.cached && !f.busy)) return { ...base, phase: "ready", note: f.note };
    if (p?.state === "initializing" || f.busy) {
      return f.cached ? { ...base, phase: "ready", note: f.note } : { ...base, phase: "downloading", fraction: f.progress };
    }
    if (f.error) return { ...base, phase: "error", error: f.error };
    if (p?.state === "unavailable" && p.lastError) return { ...base, phase: "error", error: maiaErrorText(p.lastError) };
    return { ...base, phase: f.cached === null ? "checking" : "absent" };
  }

  const state = (id) => (id === "stockfish" ? stockfishState() : maiaState());

  // A load any caller starts (Train's bot, Coverage, the coach) reports here too.
  function followMaia(provider) {
    if (provider === watchedProvider) { emit(); return; }
    stopProgress?.();
    stopProgress = null;
    watchedProvider = provider;
    facts.maia.progress = null;
    if (provider) {
      stopProgress = provider.subscribeInitProgress(({ phase, loaded, total }) => {
        if (phase === "cache") facts.maia.cached = true;
        facts.maia.progress = phase === "download" ? (total ? Math.min(1, loaded / total) : null) : 1;
        emit();
      });
    }
    emit();
  }

  async function readMaiaFacts() {
    try {
      const m = await manifest();
      const fp16 = m?.artifacts?.fp16 || {};
      facts.maia.bytes = fp16.bytes || facts.maia.bytes;
      facts.maia.key = m?.backend_artifact?.wasm || fp16.file || null;
      facts.maia.cached = facts.maia.key ? await weightsCached(facts.maia.key) : false;
    } catch {
      facts.maia.cached = false;
    }
  }

  async function refresh() {
    facts.stockfish.cached = await assetCached("big");
    await readMaiaFacts();
    emit();
  }

  function start() {
    if (started) return;
    started = true;
    subscribeAsset("big", emit);
    watchMaia(followMaia);
    followMaia(peekMaia());
    void refresh();
  }

  // Offline and a full disk are answered before a byte moves.
  async function preflight(bytes) {
    const n = nav();
    if (n?.onLine === false) throw new DownloadBlocked("You're offline. Connect to the internet and retry.");
    const estimate = await n?.storage?.estimate?.().catch(() => null);
    const free = estimate?.quota ? estimate.quota - (estimate.usage || 0) : Infinity;
    if (free < bytes) throw new DownloadBlocked(`Not enough storage: it needs ${formatMB(bytes)} and ${formatMB(Math.max(0, free))} is free.`);
  }

  // A download that finished but could not be stored works for this visit only.
  function checkKept(id) {
    later(async () => {
      const kept = id === "stockfish" ? await assetCached("big") : await weightsCached(facts.maia.key);
      facts[id].cached = kept || facts[id].cached;
      facts[id].note = kept ? null : NOT_KEPT;
      emit();
    }, 1500);
  }

  async function download(id) {
    const f = facts[id];
    if (f.busy) return state(id);
    f.error = null;
    f.note = null;
    f.busy = true;
    emit();
    try {
      await preflight(state(id).bytes);
      if (id === "stockfish") {
        // A device that has never measured itself learns first whether the net fits.
        if (fits() === null) await detect();
        if (fits() !== false) {
          await chooseFull(true);
          await loadModule("big");
          f.cached = true;
          checkKept(id);
        }
      } else {
        if (!f.key) await readMaiaFacts();
        await getMaia().warmup();
        f.cached = true;
        checkKept(id);
      }
    } catch (error) {
      f.error = errorText(id, error);
    } finally {
      f.busy = false;
      emit();
    }
    return state(id);
  }

  async function remove(id) {
    const f = facts[id];
    f.error = null;
    f.note = null;
    if (id === "stockfish") {
      await chooseFull(false).catch(() => {});
      await removeAsset("big");
    } else {
      disposeMaia();
      await clearWeights();
    }
    f.cached = false;
    emit();
  }

  return {
    downloadState(id) { start(); return state(id); },
    subscribeDownloads(fn) { start(); listeners.add(fn); return () => listeners.delete(fn); },
    startDownload: download,
    deleteDownload: remove,
    refreshDownloads() { start(); return refresh(); },
  };
}

export function errorText(id, error) {
  if (error instanceof DownloadBlocked) return error.message;
  const message = String(error?.message || error || "");
  if (error?.name === "QuotaExceededError" || /quota/i.test(message)) return "Not enough storage to keep it. Free some space and retry.";
  if (id === "maia") return maiaErrorText(error);
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status) return `The download failed (HTTP ${status}). Retry.`;
  if (/fetch|network|offline/i.test(message)) return "The download failed. Check your connection and retry.";
  return "The full engine could not start. Retry.";
}

export const { downloadState, subscribeDownloads, startDownload, deleteDownload, refreshDownloads } = createEngineDownloads();
