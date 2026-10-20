import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsView } from "./settings.js";

// Engine settings are device-local. The card must offer only the steps THIS device
// measured: a phone whose ladder stopped at big x1 cannot be offered 2 or 3,
// whichever profile the stored record names. The controls are the only place a
// user can raise the count, so disabling the steps the device never held is what
// keeps it off heaps it cannot run.

const shared = vi.hoisted(() => ({ lite: 1, big: 1, profile: { net: "lite", workers: 1, source: "fallback" } }));
vi.mock("../engine/engine-profile.js", async importOriginal => ({
  ...await importOriginal(),
  engineProfile: () => ({ ...shared.profile }),
  engineWorkerChoices: () => ({ lite: shared.lite, big: shared.big }),
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

describe("Settings → Engine offers only what this device measured", () => {
  afterEach(() => { delete globalThis.document; });

  it("disables every worker count above the measured steps on the chosen net", () => {
    shared.lite = 1; shared.big = 1; shared.profile = { net: "lite", workers: 1, source: "detected" };
    const { view, buttons } = setup();
    view.renderSettings(null);
    expect(buttons.map((b) => b.disabled)).toEqual([false, true, true]);
  });

  it("offers the big net's own measured steps when big is chosen", () => {
    shared.lite = 1; shared.big = 2; shared.profile = { net: "big", workers: 2, source: "detected" };
    const { view, buttons } = setup();
    view.renderSettings(null);
    expect(buttons.map((b) => b.disabled)).toEqual([false, false, true]);
  });

  it("leaves a capable device all three choices", () => {
    shared.lite = 3; shared.big = 3; shared.profile = { net: "big", workers: 3, source: "detected" };
    const { view, buttons } = setup();
    view.renderSettings(null);
    expect(buttons.map((b) => b.disabled)).toEqual([false, false, false]);
  });
});
