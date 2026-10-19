import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsView } from "./settings.js";

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

function harness() {
  const elements = {
    "settings-refresh": el(),
    "settings-browser-engine-status": el({ textContent: "checking…" }),
    "settings-stockfish-status": el(),
    "settings-stockfish-version": el({ textContent: "checking…" }),
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
});
