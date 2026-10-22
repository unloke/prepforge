import { describe, expect, it, vi } from "vitest";

vi.mock("./engine/engine-downloads.js", () => ({
  downloadState: vi.fn(),
  formatMB: (b) => `${Math.round(b / 1e6)} MB`,
  startDownload: vi.fn(),
  subscribeDownloads: vi.fn(() => () => {}),
}));
vi.mock("./core/prefs.js", () => ({ maiaAnalysisEnabled: vi.fn(() => false), setPref: vi.fn() }));
vi.mock("./welcome.css", () => ({}));
vi.mock("./engine-unlock.css", () => ({}));

const { shouldWelcome, offeredEngines, defaultPicks, WELCOME_KEY } = await import("./welcome.js");

const storage = (value = null) => ({ getItem: (k) => (k === WELCOME_KEY ? value : null) });
const at = (hash = "", search = "") => ({ hash, search });

describe("first-visit welcome", () => {
  it("opens once, on a plain first visit", () => {
    expect(shouldWelcome({ storage: storage(), location: at(), navigator: {} })).toBe(true);
    expect(shouldWelcome({ storage: storage(), location: at("#/dashboard"), navigator: {} })).toBe(true);
    expect(shouldWelcome({ storage: storage("done"), location: at(), navigator: {} })).toBe(false);
  });

  it("leaves links with work of their own, and automated browsers, where they asked to go", () => {
    expect(shouldWelcome({ storage: storage(), location: at("", "?join=abc"), navigator: {} })).toBe(false);
    expect(shouldWelcome({ storage: storage(), location: at("#/analyze"), navigator: {} })).toBe(false);
    expect(shouldWelcome({ storage: storage(), location: at(), navigator: { webdriver: true } })).toBe(false);
    const blocked = { getItem() { throw new Error("denied"); } };
    expect(shouldWelcome({ storage: blocked, location: at(), navigator: {} })).toBe(false);
  });

  it("offers the goal's engine first and skips what is here or cannot run", () => {
    const states = { maia: { phase: "absent", bytes: 46e6 }, stockfish: { phase: "absent", bytes: 99e6 } };
    expect(offeredEngines("practice", (id) => states[id]).map((e) => e.id)).toEqual(["maia", "stockfish"]);
    expect(offeredEngines("analyze", (id) => states[id]).map((e) => e.id)).toEqual(["stockfish", "maia"]);
    states.stockfish.phase = "unsupported";
    states.maia.phase = "ready";
    expect(offeredEngines("analyze", (id) => states[id])).toEqual([]);
  });

  it("ticks the goal's engine by default, and nothing on a metered connection", () => {
    expect([...defaultPicks("practice", {})]).toEqual(["maia"]);
    expect([...defaultPicks("analyze", { type: "wifi" })]).toEqual(["stockfish"]);
    expect([...defaultPicks("practice", { type: "cellular" })]).toEqual([]);
    expect([...defaultPicks("build", { saveData: true })]).toEqual([]);
  });
});
