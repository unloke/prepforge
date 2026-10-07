import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsView } from "./settings.js";

function el(extra = {}) {
  return {
    textContent: "",
    get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
    hidden: false,
    disabled: false,
    title: "",
    dataset: {},
    classList: { toggle: vi.fn(), contains: () => false },
    setAttribute: vi.fn(),
    getAttribute: () => null,
    addEventListener: vi.fn(),
    querySelectorAll: () => [],
    querySelector: () => null,
    ...extra,
  };
}

// A range input that snaps to step=50 like the real <input type="range" step="50">.
function rangeEl() {
  let v = "1500";
  const input = el();
  Object.defineProperty(input, "value", {
    get: () => v,
    set: (next) => {
      v = String(Math.round((Number(next) - 600) / 50) * 50 + 600);
    },
  });
  return input;
}

function setup({ appState = {}, api, pref = () => false, effective = 2377 } = {}) {
  const elements = {
    "settings-depth": el({ value: "16" }),
    "settings-depth-readout": el(),
    "settings-maia-auto": el(),
    "settings-maia-auto-label": el({ textContent: "Auto" }),
    "settings-maia-rating": rangeEl(),
    "settings-maia-rating-readout": el(),
    "settings-lichess-accounts": el(),
    "settings-link-lichess": el(),
    "settings-maia-analysis": el(),
    "settings-maia-analysis-hint": el(),
    "settings-maia-usage": el(),
  };
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: vi.fn(),
  };
  const state = { lichessUsername: "me", maiaAutoRating: 2377, maiaRatingPinned: null, ...appState };
  const saveSettings = vi.fn(async () => {});
  const view = createSettingsView({
    appState: state,
    setStatus: vi.fn(),
    saveSettings,
    loadSettings: vi.fn(),
    pref,
    setPref: vi.fn(),
    effectiveMaiaRating: () => effective,
    maiaFallbackRating: 1500,
    getSharedMaia3Provider: () => ({ state: "ready", info: {} }),
    disposeSharedMaia3Provider: vi.fn(),
    showConfirmModal: vi.fn(),
    startFen: "startpos",
    api: api || (async () => ({ linked: false, accounts: [] })),
    postJson: async () => ({}),
    startLichessOAuth: vi.fn(),
    onAccountsChanged: vi.fn(),
  });
  return { view, elements, state, saveSettings };
}

afterEach(() => {
  delete globalThis.document;
});

describe("settings strength controls", () => {
  it("Auto on: slider usable and the readout shows the real auto rating", () => {
    const { view, elements } = setup();
    view.renderStrengthControls();
    expect(elements["settings-maia-rating"].disabled).toBe(false);
    expect(elements["settings-maia-rating"].value).toBe("2400"); // thumb snaps…
    expect(elements["settings-maia-rating-readout"].textContent).toBe("2377"); // …readout doesn't
    expect(elements["settings-maia-auto-label"].textContent).toBe("Auto");
  });

  it("Auto off: slider enabled and the readout follows the slider", () => {
    const { view, elements } = setup({ appState: { maiaRatingPinned: 1800 }, effective: 1800 });
    view.renderStrengthControls();
    expect(elements["settings-maia-rating"].disabled).toBe(false);
    expect(elements["settings-maia-rating-readout"].textContent).toBe("1800");
  });
  it("moving the slider selects manual strength and saves it", () => {
    const { view, elements, state, saveSettings } = setup();
    view.bind();
    const slider = elements["settings-maia-rating"];
    slider.value = "1850";
    const handler = (type) => slider.addEventListener.mock.calls.find(([name]) => name === type)[1];
    handler("input")();
    expect(state.maiaRatingPinned).toBe(1850);
    expect(elements["settings-maia-auto"].setAttribute).toHaveBeenLastCalledWith("aria-checked", "false");
    expect(elements["settings-maia-rating-readout"].textContent).toBe("1850");
    handler("change")();
    expect(saveSettings).toHaveBeenCalledWith({ maia_rating: 1850 });
  });

});

describe("settings chess accounts loading state", () => {
  it("shows a loading line (no Link button) until /api/lichess answers", async () => {
    let resolve;
    const api = vi.fn(() => new Promise((r) => (resolve = r)));
    const { view, elements } = setup({
      appState: { signedIn: true, lichessUsername: null, lichessAccounts: undefined },
      api,
    });
    const pending = view.renderConnections();
    expect(String(elements["settings-lichess-accounts"].innerHTML)).toContain("Checking linked accounts");
    expect(elements["settings-link-lichess"].hidden).toBe(true);
    resolve({ linked: true, accounts: [{ id: "a", username: "me_on_lichess", is_primary: true }] });
    await pending;
    expect(String(elements["settings-lichess-accounts"].innerHTML)).toContain("me_on_lichess");
    expect(elements["settings-link-lichess"].hidden).toBe(false);
  });

  it("known state renders immediately without a fetch", async () => {
    const api = vi.fn();
    const { view, elements } = setup({
      appState: { signedIn: true, lichessUsername: null, lichessAccounts: [] },
      api,
    });
    await view.renderConnections();
    expect(api).not.toHaveBeenCalled();
    expect(String(elements["settings-lichess-accounts"].innerHTML)).toContain("No Lichess account linked yet");
  });
});

describe("Maia analysis vs Maia3 Ready", () => {
  it("reports Maia analysis as off without a standing explanation", () => {
    const { view, elements } = setup({ pref: () => false });
    view.renderSettings(null);
    expect(elements["settings-maia-usage"].textContent).toBe("Not in use");
  });
});
