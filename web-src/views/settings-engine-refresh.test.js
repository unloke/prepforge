import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsView } from "./settings.js";

const shared = vi.hoisted(() => ({ setup: {}, listeners: new Set() }));
vi.mock("../engine/engine-profile.js", async importOriginal => ({ ...await importOriginal(),
  engineSetupState: () => ({ ...shared.setup }),
  subscribeEngineSetup: fn => {
    shared.listeners.add(fn); fn({ ...shared.setup });
    return () => shared.listeners.delete(fn);
  },
}));

// Engine "Refresh" sits next to the browser-engine rows, so it must re-check
// them too: a click used to reload /api/settings and leave the browser row
// ("checking…" / "unavailable") and the version text exactly as they were.
function el(extra = {}) {
  const listeners = {};
  return {
    textContent: "",
    className: "",
    hidden: false,
    disabled: false,
    title: "",
    value: "",
    dataset: {},
    classList: { toggle: () => {}, contains: () => false },
    setAttribute: () => {},
    getAttribute: () => null,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: (type) => { for (const fn of listeners[type] || []) fn({}); },
    querySelectorAll: () => [],
    querySelector: () => null,
    ...extra,
  };
}

// The setup bar is driven by a CSS variable (the fill scales with --progress),
// so the mock keeps the properties it was given.
function styleMock() {
  const props = {};
  return { props, setProperty: (name, value) => { props[name] = value; } };
}

function harness() {
  const elements = {
    "settings-refresh": el(),
    "settings-browser-engine-status": el({ textContent: "checking…" }),
    "settings-stockfish-status": el(),
    "settings-stockfish-version": el({ textContent: "checking…" }),
    "settings-profile-status": el(),
    "settings-profile-progress": el({ firstElementChild: { style: styleMock() } }),
    "settings-detect": el(),
  };
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const loadSettings = vi.fn(async () => {});
  const view = createSettingsView({
    appState: { signedIn: true, authKnown: true, settings: {} },
    setStatus: () => {},
    saveSettings: async () => {},
    loadSettings,
    pref: () => "system",
    setPref: () => {},
    effectiveMaiaRating: () => 2377,
    getSharedMaia3Provider: () => null,
    disposeSharedMaia3Provider: () => {},
    showConfirmModal: async () => false,
    startFen: "start",
    api: async () => ({}),
    postJson: async () => ({}),
    signOut: async () => {},
    openAuthModal: () => {},
    refreshAuthStatus: async () => {},
  });
  view.bind();
  return { view, elements, loadSettings };
}

describe("Settings → Engine Refresh", () => {
  const realFetch = globalThis.fetch;
  let selfDescriptor;
  beforeEach(() => {
    shared.setup = { phase: "idle", fraction: 0, loaded: 0, total: 0, label: "" };
    shared.listeners.clear();
    selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, "self");
    Object.defineProperty(globalThis, "self", { value: { crossOriginIsolated: false }, configurable: true, writable: true });
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ engines: { lite: { packageVersion: "17.1", id: "sf" } } }) }));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (selfDescriptor) Object.defineProperty(globalThis, "self", selfDescriptor);
    else delete globalThis.self;
  });

  it("re-checks the browser engine as well as the saved settings", async () => {
    const { elements, loadSettings } = harness();
    elements["settings-refresh"].fire("click");
    await new Promise((r) => setTimeout(r, 0));
    // The server settings read still happens…
    expect(loadSettings).toHaveBeenCalledTimes(1);
    // …and the browser row is re-derived, not left on its boot value.
    expect(elements["settings-browser-engine-status"].textContent).toBe("unavailable");
    await vi.waitFor(() => {
      expect(elements["settings-stockfish-version"].textContent).toMatch(/^Stockfish 17\.1 lite/);
    });
  });

  it("replays background progress and updates bytes and compilation without refetching the manifest", async () => {
    shared.setup = { phase: "download", fraction: 0.25, loaded: 1048576, total: 4194304, label: "Downloading full engine…" };
    const { view, elements } = harness();
    const bar = elements["settings-profile-progress"];
    expect(bar.hidden).toBe(false);
    // Getting the net fills the first half of the one setup bar.
    expect(bar.firstElementChild.style.props["--progress"]).toBe("0.125");
    expect(elements["settings-profile-status"].textContent).toContain("1 / 4 MB");
    await view.refreshEngineCard();
    const fetches = globalThis.fetch.mock.calls.length;
    shared.setup = { ...shared.setup, fraction: 0.75, loaded: 3145728 };
    for (const fn of shared.listeners) fn(shared.setup);
    expect(bar.firstElementChild.style.props["--progress"]).toBe("0.375");
    shared.setup = { ...shared.setup, phase: "compile", fraction: 1, label: "Compiling engine…" };
    for (const fn of shared.listeners) fn(shared.setup);
    expect(elements["settings-profile-status"].textContent).toBe("Compiling engine…");
    expect(globalThis.fetch).toHaveBeenCalledTimes(fetches);
    view.dispose();
    expect(shared.listeners.size).toBe(0);
  });
});
