import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

function loadSettingsSource() {
  return readFileSync(join(root, "..", "views", "settings.js"), "utf8");
}

function makeDom() {
  const elements = {};
  const mk = (id, extra = {}) => {
    elements[id] = {
      textContent: "",
      hidden: false,
      disabled: false,
      dataset: {},
      classList: { toggle: vi.fn(), contains: () => false },
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      ...extra,
    };
    return elements[id];
  };
  mk("settings-maia-model");
  mk("settings-maia-status");
  mk("settings-maia-error");
  mk("settings-maia-retry");
  mk("settings-maia-reset");
  mk("settings-maia-analysis", { click: vi.fn() });
  mk("settings-lichess-accounts", { innerHTML: "" });
  mk("settings-link-lichess");
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.fetch = vi.fn();
  return elements;
}

describe("maia3 health status model", () => {
  beforeEach(() => {
    delete globalThis.document;
    delete globalThis.fetch;
    vi.resetModules();
  });

  it("defines a fixed independent status vocabulary", () => {
    const src = loadSettingsSource();
    for (const label of [
      "Ready",
      "Available on demand",
      "Loading",
      "Cache missing",
      "Unavailable",
      "Error",
    ]) {
      expect(src).toContain(`"${label}"`);
    }
  });

  it("renders provider states without consulting the analysis toggle", () => {
    const src = loadSettingsSource();
    expect(src).toContain("MAIA_STATUS.READY");
    expect(src).toContain("MAIA_STATUS.LOADING");
    expect(src).toContain("MAIA_STATUS.UNAVAILABLE");
    expect(src).toContain("MAIA_STATUS.ERROR");
    expect(src).toContain("MAIA_STATUS.CACHE_MISSING");
    expect(src).toContain("MAIA_STATUS.AVAILABLE");
  });

  it("status render peeks only; retry constructs and verifies", async () => {
    const elements = makeDom();
    const settings = await import("./settings.js");
    let constructed = 0;
    const statuses = [];
    const view = settings.createSettingsView({
      appState: { lichessAccounts: [] },
      setStatus: (msg) => statuses.push(msg),
      saveSettings: vi.fn(),
      loadSettings: vi.fn(),
      pref: (name) => (name === "maiaAnalysis" ? false : "system"),
      setPref: vi.fn(),
      effectiveMaiaRating: () => 1500,
      maiaFallbackRating: 1500,
      getSharedMaia3Provider: () => {
        constructed += 1;
        return { predictions: async () => [{ move_uci: "e2e4" }] };
      },
      disposeSharedMaia3Provider: vi.fn(),
      showConfirmModal: vi.fn(),
      startFen: "startpos",
      api: async () => ({}),
      postJson: async () => ({}),
    });
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        asset_base: "/static/maia3/",
        backend_artifact: { wasm: "maia3-x.onnx" },
        artifacts: { fp16: { file: "maia3-x.onnx", bytes: 46 * 1024 * 1024 } },
      }),
    });
    const weights = await import("../engine/maia3-weight-cache.js");
    const spy = vi.spyOn(weights, "getCachedWeights").mockResolvedValue(null);
    await view.renderMaia3Status();
    expect(constructed).toBe(0);
    expect(elements["settings-maia-model"].textContent).toBe("Cache missing");
    // Nothing failed yet: the button offers the download, not a "Retry".
    expect(elements["settings-maia-retry"].textContent).toBe("Download");
    await view.retryMaia3();
    expect(constructed).toBe(1);
    expect(statuses).toContain("Maia3 ready");
    expect(elements["settings-maia-retry"].disabled).toBe(false);
    spy.mockRestore();
  });

  it("retry works with analysis OFF and reset cache stays available", async () => {
    makeDom();
    const src = loadSettingsSource();
    expect(src).not.toMatch(/Maia analysis is off — turn it on in Playing strength first/);
    const settings = await import("./settings.js");
    const statuses = [];
    let verified = 0;
    const view = settings.createSettingsView({
      appState: { lichessAccounts: [] },
      setStatus: (msg) => statuses.push(msg),
      saveSettings: vi.fn(),
      loadSettings: vi.fn(),
      pref: (name) => (name === "maiaAnalysis" ? false : "system"),
      setPref: vi.fn(),
      effectiveMaiaRating: () => 1500,
      maiaFallbackRating: 1500,
      getSharedMaia3Provider: () => {
        verified += 1;
        return { predictions: async () => [{ move_uci: "e2e4" }] };
      },
      disposeSharedMaia3Provider: vi.fn(),
      showConfirmModal: vi.fn(),
      startFen: "startpos",
      api: async () => ({}),
      postJson: async () => ({}),
    });
    await view.retryMaia3();
    expect(verified).toBe(1);
    expect(statuses).toContain("Maia3 ready");
    expect(typeof view.resetMaia3Cache).toBe("function");
    expect(typeof view.verifyMaia3).toBe("function");
  });

  it("shows Ready when cached weights are present with analysis OFF", async () => {
    const elements = makeDom();
    const settings = await import("./settings.js");
    const view = settings.createSettingsView({
      appState: { lichessAccounts: [] },
      setStatus: vi.fn(),
      saveSettings: vi.fn(),
      loadSettings: vi.fn(),
      pref: (name) => (name === "maiaAnalysis" ? false : "system"),
      setPref: vi.fn(),
      effectiveMaiaRating: () => 1500,
      maiaFallbackRating: 1500,
      getSharedMaia3Provider: () => {
        throw new Error("must not construct during peek render");
      },
      disposeSharedMaia3Provider: vi.fn(),
      showConfirmModal: vi.fn(),
      startFen: "startpos",
      api: async () => ({}),
      postJson: async () => ({}),
    });
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        asset_base: "/static/maia3/",
        backend_artifact: { wasm: "maia3-x.onnx" },
        artifacts: { fp16: { file: "maia3-x.onnx", bytes: 46 * 1024 * 1024 } },
      }),
    });
    const weights = await import("../engine/maia3-weight-cache.js");
    const spy = vi.spyOn(weights, "getCachedWeights").mockResolvedValue(new ArrayBuffer(8));
    await view.renderMaia3Status();
    expect(elements["settings-maia-model"].textContent).toBe("Ready");
    spy.mockRestore();
  });

  it("surfaces provider failure as Unavailable with the error detail", async () => {
    const elements = makeDom();
    vi.resetModules();
    const settings = await import("./settings.js");
    const provider = await import("../engine/maia3-provider.js");
    const view = settings.createSettingsView({
      appState: { lichessAccounts: [] },
      setStatus: vi.fn(),
      saveSettings: vi.fn(),
      loadSettings: vi.fn(),
      pref: () => true,
      setPref: vi.fn(),
      effectiveMaiaRating: () => 1500,
      maiaFallbackRating: 1500,
      getSharedMaia3Provider: () => provider.getSharedMaia3Provider(),
      disposeSharedMaia3Provider: vi.fn(),
      showConfirmModal: vi.fn(),
      startFen: "startpos",
      api: async () => ({}),
      postJson: async () => ({}),
    });
    const failing = provider.createMaia3Provider({
      createWorker: () => {
        throw new Error("no worker");
      },
      manifest: { asset_base: "/static/maia3/" },
    });
    const peek = vi.spyOn(provider, "peekSharedMaia3Provider").mockReturnValue({
      state: "unavailable",
      lastError: { message: "boom", phase: "init" },
      info: {},
    });
    void failing;
    await view.renderMaia3Status();
    expect(elements["settings-maia-model"].textContent).toBe("Unavailable");
    expect(elements["settings-maia-error"].textContent).toContain("boom (init)");
    peek.mockRestore();
  });

  it("fetches the manifest once per Settings paint, not once per status row", async () => {
    // renderSettings calls renderBrowserEngineStatus and renderMaiaAnalysis, and
    // both reach renderMaia3Status — three manifest reads per paint before the
    // memo, on the cold load AND again on every Settings entry.
    const elements = makeDom();
    const settings = await import("./settings.js");
    const view = settings.createSettingsView({
      appState: { lichessAccounts: [] },
      setStatus: vi.fn(),
      setStatusError: vi.fn(),
      saveSettings: vi.fn(),
      loadSettings: vi.fn(),
      pref: (name) => (name === "maiaAnalysis" ? false : "system"),
      setPref: vi.fn(),
      effectiveMaiaRating: () => 1500,
      maiaFallbackRating: 1500,
      getSharedMaia3Provider: () => ({ predictions: async () => [] }),
      disposeSharedMaia3Provider: vi.fn(),
      showConfirmModal: vi.fn(),
      startFen: "startpos",
      api: async () => ({}),
      postJson: async () => ({}),
    });
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        asset_base: "/static/maia3/",
        backend_artifact: { wasm: "maia3-x.onnx" },
        artifacts: { fp16: { file: "maia3-x.onnx", bytes: 46 * 1024 * 1024 } },
      }),
    });
    const weights = await import("../engine/maia3-weight-cache.js");
    const spy = vi.spyOn(weights, "getCachedWeights").mockResolvedValue(null);
    // One paint: every caller shares the in-flight (then settled) promise.
    await Promise.all([view.renderMaia3Status(), view.renderMaia3Status(), view.renderMaia3Status()]);
    await view.renderMaia3Status();
    const manifestReads = () => globalThis.fetch.mock.calls.filter(([url]) => String(url).includes("maia3.manifest.json"));
    expect(manifestReads()).toHaveLength(1);
    // A later repaint reuses the resolved manifest rather than re-reading it.
    await view.renderMaia3Status();
    expect(manifestReads()).toHaveLength(1);
    expect(elements["settings-maia-model"].textContent).toBe("Cache missing");
    spy.mockRestore();
  });

  it("retries the manifest after a failed read", async () => {
    // A failed read must not pin the memo, or every later paint reports
    // "manifest is not reachable" for the rest of the session.
    const elements = makeDom();
    const settings = await import("./settings.js");
    const view = settings.createSettingsView({
      appState: { lichessAccounts: [] },
      setStatus: vi.fn(),
      setStatusError: vi.fn(),
      saveSettings: vi.fn(),
      loadSettings: vi.fn(),
      pref: () => false,
      setPref: vi.fn(),
      effectiveMaiaRating: () => 1500,
      maiaFallbackRating: 1500,
      getSharedMaia3Provider: () => ({ predictions: async () => [] }),
      disposeSharedMaia3Provider: vi.fn(),
      showConfirmModal: vi.fn(),
      startFen: "startpos",
      api: async () => ({}),
      postJson: async () => ({}),
    });
    globalThis.fetch.mockRejectedValueOnce(new Error("offline"));
    await view.renderMaia3Status();
    expect(elements["settings-maia-model"].textContent).toBe("Unavailable");
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ asset_base: "/static/maia3/", artifacts: { fp16: { file: "x.onnx", bytes: 1 } } }),
    });
    const weights = await import("../engine/maia3-weight-cache.js");
    const spy = vi.spyOn(weights, "getCachedWeights").mockResolvedValue(null);
    await view.renderMaia3Status();
    expect(elements["settings-maia-model"].textContent).not.toBe("Unavailable");
    expect(globalThis.fetch.mock.calls.filter(([url]) => String(url).includes("maia3.manifest.json")))
      .toHaveLength(2);
    spy.mockRestore();
  });
});
