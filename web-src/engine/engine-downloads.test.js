import { describe, expect, it, vi } from "vitest";

const { createEngineDownloads, errorText, formatMB } = await import("./engine-downloads.js");

// A store wired to fakes: the full net's asset manager, the device fit, the Maia
// provider and its weight cache, and the browser's network and storage signals.
function harness({ fits = true, cachedBig = false, cachedMaia = false, online = true, free = 10e9, warmup } = {}) {
  let asset = { phase: "idle", loaded: 0, total: 99_065_439, error: null };
  const assetListeners = new Set();
  const setAsset = (next) => { asset = { ...asset, ...next }; for (const fn of assetListeners) fn(asset); };
  let fit = fits;
  let provider = null;
  let shared = null;
  const progress = new Set();
  const deps = {
    assetState: () => ({ ...asset }),
    subscribeAsset: (_net, fn) => { assetListeners.add(fn); return () => assetListeners.delete(fn); },
    assetCached: vi.fn(async () => cachedBig),
    loadModule: vi.fn(async () => { setAsset({ phase: "download", loaded: 50_000_000 }); setAsset({ phase: "ready" }); return {}; }),
    removeAsset: vi.fn(async () => setAsset({ phase: "idle", loaded: 0 })),
    fits: () => fit,
    chooseFull: vi.fn(async () => {}),
    detect: vi.fn(async () => { fit = fits === null ? true : fits; }),
    manifest: async () => ({ artifacts: { fp16: { file: "maia3.onnx", bytes: 46_417_576 } } }),
    peekMaia: () => provider,
    getMaia: () => {
      provider ||= {
        state: "idle",
        lastError: null,
        subscribeInitProgress: (fn) => { progress.add(fn); return () => progress.delete(fn); },
        warmup: vi.fn(async () => {
          provider.state = "initializing";
          shared?.(provider);
          for (const fn of progress) fn({ phase: "download", loaded: 23_208_788, total: 46_417_576 });
          if (warmup) {
            try { await warmup(provider); } catch (error) { provider.state = "unavailable"; provider.lastError = error; shared?.(provider); throw error; }
          }
          provider.state = "ready";
          shared?.(provider);
        }),
      };
      shared?.(provider);
      return provider;
    },
    disposeMaia: vi.fn(() => { provider = null; shared?.(null); }),
    watchMaia: (fn) => { shared = fn; return () => {}; },
    weightsCached: vi.fn(async () => cachedMaia),
    clearWeights: vi.fn(async () => true),
    navigator: () => ({ onLine: online, storage: { estimate: async () => ({ quota: free + 1e9, usage: 1e9 }) } }),
    later: (fn) => fn(),
  };
  const store = createEngineDownloads(deps);
  return { store, deps, setAsset, setFit: (v) => { fit = v; } };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("engine downloads", () => {
  it("quotes sizes in decimal MB", () => {
    expect(formatMB(99_065_439)).toBe("99 MB");
    expect(formatMB(46_417_576)).toBe("46 MB");
  });

  it("starts as not downloaded once the caches have been read, with real sizes", async () => {
    const { store } = harness();
    expect(store.downloadState("stockfish").phase).toBe("checking");
    await store.refreshDownloads();
    expect(store.downloadState("stockfish")).toMatchObject({ phase: "absent", bytes: globalThis.__STOCKFISH__.big.bytes });
    expect(store.downloadState("maia")).toMatchObject({ phase: "absent", bytes: 46_417_576 });
  });

  it("reads bytes already on disk as ready, without loading them", async () => {
    const { store, deps } = harness({ cachedBig: true, cachedMaia: true });
    await store.refreshDownloads();
    expect(store.downloadState("stockfish")).toMatchObject({ phase: "ready", version: "v19" });
    expect(store.downloadState("maia").phase).toBe("ready");
    expect(deps.loadModule).not.toHaveBeenCalled();
  });

  it("downloads the full net with progress, and only after the device's yes", async () => {
    const { store, deps, setAsset } = harness();
    await store.refreshDownloads();
    const seen = [];
    store.subscribeDownloads(() => seen.push(store.downloadState("stockfish").phase));
    deps.loadModule.mockImplementationOnce(async () => {
      setAsset({ phase: "download", loaded: 49_532_720 });
      const mid = store.downloadState("stockfish");
      expect(mid.phase).toBe("downloading");
      expect(mid.fraction).toBeCloseTo(0.5, 3);
      setAsset({ phase: "ready" });
    });
    const result = await store.startDownload("stockfish");
    expect(deps.chooseFull).toHaveBeenCalledWith(true);
    expect(result.phase).toBe("ready");
    expect(seen).toContain("downloading");
  });

  it("measures an unmeasured device first, and offers nothing it cannot hold", async () => {
    const unknown = harness({ fits: null });
    await unknown.store.refreshDownloads();
    await unknown.store.startDownload("stockfish");
    expect(unknown.deps.detect).toHaveBeenCalled();
    expect(unknown.deps.chooseFull).toHaveBeenCalledWith(true);

    const small = harness({ fits: false });
    await small.store.refreshDownloads();
    expect(small.store.downloadState("stockfish").phase).toBe("unsupported");
  });

  it("answers offline and a full disk before any byte moves", async () => {
    const offline = harness({ online: false });
    await offline.store.refreshDownloads();
    const a = await offline.store.startDownload("maia");
    expect(a).toMatchObject({ phase: "error", error: "You're offline. Connect to the internet and retry." });

    const full = harness({ free: 20e6 });
    await full.store.refreshDownloads();
    const b = await full.store.startDownload("stockfish");
    expect(b.phase).toBe("error");
    expect(b.error).toBe(`Not enough storage: it needs ${formatMB(globalThis.__STOCKFISH__.big.bytes)} and 20 MB is free.`);
    expect(full.deps.loadModule).not.toHaveBeenCalled();
  });

  it("follows a Maia load another caller started, and keeps a failure readable for Retry", async () => {
    const { store, deps } = harness({ warmup: async () => { throw new Error("weight fetch 503"); } });
    await store.refreshDownloads();
    const result = await store.startDownload("maia");
    expect(result).toMatchObject({ phase: "error", error: "The Maia download failed (HTTP 503). Retry." });
    const provider = deps.peekMaia();
    provider.state = "unavailable";
    provider.warmup.mockImplementationOnce(async () => { provider.state = "ready"; });
    expect((await store.startDownload("maia")).phase).toBe("ready");
  });

  it("marks a download that could not be stored as this visit only", async () => {
    const { store } = harness({ cachedMaia: false });
    await store.refreshDownloads();
    const state = await store.startDownload("maia");
    expect(state.phase).toBe("ready");
    await settle();
    expect(store.downloadState("maia").note).toMatch(/this visit only/);
  });

  it("deletes to free the space: the full net steps down to lite, Maia leaves IndexedDB", async () => {
    const { store, deps } = harness({ cachedBig: true, cachedMaia: true });
    await store.refreshDownloads();
    await store.deleteDownload("stockfish");
    expect(deps.chooseFull).toHaveBeenCalledWith(false);
    expect(deps.removeAsset).toHaveBeenCalledWith("big");
    expect(store.downloadState("stockfish").phase).toBe("absent");
    await store.deleteDownload("maia");
    expect(deps.disposeMaia).toHaveBeenCalled();
    expect(deps.clearWeights).toHaveBeenCalled();
    expect(store.downloadState("maia").phase).toBe("absent");
  });
});

describe("download error text", () => {
  it("says what failed and what clears it", () => {
    expect(errorText("stockfish", new Error("Engine asset failed: HTTP 404 loading /x"))).toBe("The download failed (HTTP 404). Retry.");
    expect(errorText("stockfish", new TypeError("Failed to fetch"))).toBe("The download failed. Check your connection and retry.");
    expect(errorText("maia", Object.assign(new Error("quota"), { name: "QuotaExceededError" }))).toMatch(/Not enough storage/);
    expect(errorText("maia", new Error("Maia3 weight download stalled"))).toBe("The Maia download stopped part-way. Retry.");
  });
});
