import { describe, expect, it, vi } from "vitest";

vi.mock("./engine/engine-downloads.js", () => ({
  downloadState: vi.fn(),
  formatMB: (b) => `${Math.round(b / 1e6)} MB`,
  startDownload: vi.fn(),
  subscribeDownloads: vi.fn(() => () => {}),
}));
vi.mock("./core/prefs.js", () => ({ maiaAnalysisEnabled: vi.fn(() => false), setPref: vi.fn() }));
vi.mock("./engine-unlock.css", () => ({}));

const { UNLOCK_PLACES, unlockView, unlockHtml } = await import("./engine-unlock.js");

const state = (phase, extra = {}) => () => ({ id: "maia", phase, bytes: 46_417_576, fraction: null, ...extra });
const none = new Set();

describe("unlock rows", () => {
  it("cover every place a local engine matters, each with what it adds there", () => {
    expect(Object.keys(UNLOCK_PLACES).sort()).toEqual(
      ["analyze-coach", "build-coverage", "engine-analyze", "engine-build", "scout", "train-practice"]);
    for (const { engine, gain } of Object.values(UNLOCK_PLACES)) {
      expect(["stockfish", "maia"]).toContain(engine);
      expect(gain.length).toBeGreaterThan(10);
    }
  });

  it("offers a download with its size, then shows progress, then gets out of the way", () => {
    const offer = unlockView("train-practice", { state: state("absent"), dismissed: none });
    expect(offer.mode).toBe("offer");
    const markup = String(unlockHtml("train-practice", offer));
    expect(markup).toContain("Maia 3");
    expect(markup).toContain("46 MB");
    expect(markup).toContain("plays like a human");

    const progress = unlockView("train-practice", { state: state("downloading", { fraction: 0.37 }), dismissed: none });
    expect(String(unlockHtml("train-practice", progress))).toContain("Downloading · 37% of 46 MB");
    expect(String(unlockHtml("train-practice", progress))).toContain('aria-valuenow="37"');

    expect(unlockView("train-practice", { state: state("ready"), dismissed: none })).toBeNull();
  });

  it("asks an analysis layer to turn on a model that is already here, without a size", () => {
    const view = unlockView("analyze-coach", { state: state("ready"), enabled: () => false, dismissed: none });
    expect(view.mode).toBe("enable");
    expect(String(unlockHtml("analyze-coach", view))).toContain("Turn on");
    expect(unlockView("analyze-coach", { state: state("ready"), enabled: () => true, dismissed: none })).toBeNull();
  });

  it("shows a failure in words with Retry", () => {
    const view = unlockView("scout", { state: state("error", { error: "You're offline. Connect to the internet and retry." }), dismissed: none });
    const markup = String(unlockHtml("scout", view));
    expect(markup).toContain("offline");
    expect(markup).toContain("Retry");
    expect(markup).toContain('role="alert"');
  });

  it("stays away per place once put away, and never shows where the device cannot run it", () => {
    const away = new Set(["engine-analyze"]);
    const sf = () => ({ id: "stockfish", phase: "absent", bytes: 99e6 });
    expect(unlockView("engine-analyze", { state: sf, dismissed: away })).toBeNull();
    expect(unlockView("engine-build", { state: sf, dismissed: away }).mode).toBe("offer");
    expect(unlockView("engine-build", { state: () => ({ phase: "unsupported", bytes: 99e6 }), dismissed: none })).toBeNull();
    expect(unlockView("engine-build", { state: () => ({ phase: "checking", bytes: 99e6 }), dismissed: none })).toBeNull();
  });

  it("has a one-line form for hosts with a fixed row height", () => {
    const view = unlockView("analyze-coach", { state: state("absent"), dismissed: none });
    expect(String(unlockHtml("analyze-coach", view, { inline: true }))).toContain('class="unlock is-inline"');
  });
});
