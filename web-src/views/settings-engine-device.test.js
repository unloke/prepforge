import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsView } from "./settings.js";

// Engine settings are device-local. The card must show what THIS device can run:
// a phone that holds one engine cannot be offered 2 or 3, whichever profile the
// stored record names. The controls are the only place a user can raise the count,
// so disabling them past the device limit is what keeps a phone off three heaps.

const shared = vi.hoisted(() => ({ limit: 1, profile: { net: "lite", workers: 1, source: "fallback" } }));
vi.mock("../engine/engine-profile.js", async importOriginal => ({
  ...await importOriginal(),
  engineProfile: () => ({ ...shared.profile }),
  engineWorkerLimit: () => shared.limit,
  engineMeasurements: () => null,
  engineSetupState: () => ({ phase: "idle", fraction: 0, loaded: 0, total: 0, label: "" }),
  subscribeEngineProfile: () => () => {},
  subscribeEngineSetup: () => () => {},
}));

function button(value) {
  return { dataset: { workers: String(value) }, disabled: false, classList: { toggle: () => {} },
    setAttribute: () => {}, addEventListener: () => {} };
}

function setup() {
  const buttons = [button(1), button(2), button(3)];
  const elements = {
    "settings-workers-seg": { querySelectorAll: () => buttons },
    "settings-net-seg": { querySelectorAll: () => [] },
    "settings-profile-status": { textContent: "", title: "" },
    "settings-profile-progress": { hidden: true, firstElementChild: { style: { setProperty: () => {} } } },
    "settings-detect": { disabled: false },
    "settings-stockfish-version": { textContent: "" },
  };
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const view = createSettingsView({
    appState: { signedIn: true, authKnown: true, settings: {} },
    setStatus: () => {}, saveSettings: async () => {}, loadSettings: async () => {},
    pref: () => "system", setPref: () => {}, effectiveMaiaRating: () => 1500,
    getSharedMaia3Provider: () => null, disposeSharedMaia3Provider: () => {},
    showConfirmModal: async () => false, startFen: "start",
    api: async () => ({}), postJson: async () => ({}),
    signOut: async () => {}, openAuthModal: async () => {}, refreshAuthStatus: async () => {},
  });
  return { view, buttons };
}

describe("Settings → Engine shows what this device can hold", () => {
  afterEach(() => { delete globalThis.document; });

  it("disables every worker count above the device's limit", () => {
    shared.limit = 1;
    const { view, buttons } = setup();
    view.renderSettings(null);
    expect(buttons.map((b) => b.disabled)).toEqual([false, true, true]);
  });

  it("leaves a capable device all three choices", () => {
    shared.limit = 3;
    const { view, buttons } = setup();
    view.renderSettings(null);
    expect(buttons.map((b) => b.disabled)).toEqual([false, false, false]);
  });
});
