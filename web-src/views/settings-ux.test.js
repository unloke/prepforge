import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsView } from "./settings.js";

// UX walkthrough 2026-09-30, P2-12:
//  - with Auto on, the Maia3 strength slider is disabled and its readout shows
//    the real auto rating (2377), not the 50-step snapped thumb (2400);
//  - the chess-accounts block shows a loading line (no "Link a Lichess
//    account" button) until the linked-account state is known;
//  - the Maia analysis switch explains that Maia3 "Ready" only means downloaded.

function el(extra = {}) {
  return {
    textContent: "",
    innerHTML: "",
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
    "settings-maia-auto-label": el(),
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
  const view = createSettingsView({
    appState: { lichessUsername: "me", maiaAutoRating: 2377, maiaRatingPinned: null, ...appState },
    setStatus: vi.fn(),
    saveSettings: vi.fn(),
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
  return { view, elements };
}

afterEach(() => {
  delete globalThis.document;
});

describe("settings strength controls", () => {
  it("Auto on: slider disabled and the readout shows the real auto rating", () => {
    const { view, elements } = setup();
    view.renderStrengthControls();
    expect(elements["settings-maia-rating"].disabled).toBe(true);
    expect(elements["settings-maia-rating"].value).toBe("2400"); // thumb snaps…
    expect(elements["settings-maia-rating-readout"].textContent).toBe("2377"); // …readout doesn't
    expect(elements["settings-maia-auto-label"].textContent).toContain("~2377");
  });

  it("Auto off: slider enabled and the readout follows the slider", () => {
    const { view, elements } = setup({ appState: { maiaRatingPinned: 1800 }, effective: 1800 });
    view.renderStrengthControls();
    expect(elements["settings-maia-rating"].disabled).toBe(false);
    expect(elements["settings-maia-rating-readout"].textContent).toBe("1800");
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
    expect(elements["settings-lichess-accounts"].innerHTML).toContain("Checking linked accounts");
    expect(elements["settings-link-lichess"].hidden).toBe(true);
    resolve({ linked: true, accounts: [{ id: "a", username: "me_on_lichess", is_primary: true }] });
    await pending;
    expect(elements["settings-lichess-accounts"].innerHTML).toContain("me_on_lichess");
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
    expect(elements["settings-lichess-accounts"].innerHTML).toContain("No Lichess account linked yet");
  });
});

describe("Maia analysis vs Maia3 Ready", () => {
  it("explains that Ready means downloaded while analysis is off", () => {
    const { view, elements } = setup({ pref: () => false });
    view.renderSettings(null);
    expect(elements["settings-maia-analysis-hint"].textContent).toMatch(/Stockfish only/);
    expect(elements["settings-maia-analysis-hint"].textContent).toMatch(/Coverage scans require Maia analysis/);
    expect(elements["settings-maia-usage"].textContent).toMatch(/Maia analysis is off/);
  });
});
