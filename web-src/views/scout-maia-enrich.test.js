import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamGames = vi.fn();
const wdlReadMock = vi.fn(async () => ({ wdl: { win: 300, draw: 300, loss: 400 } }));

vi.mock("../engine/maia3-provider.js", () => ({
  getSharedMaia3Provider: () => ({ wdlRead: wdlReadMock, state: "ready" }),
}));

// Explorer/engine are optional; stub them inert so they never re-render and never
// fetch, so we isolate the Maia enrichment orchestration.
vi.mock("../scout-explorer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    collectExplorerProbePositions: vi.fn(() => []),
    fetchExplorerReads: vi.fn(async () => ({ available: false })),
  };
});
vi.mock("../explorer.js", () => ({ createExplorerClient: () => ({ fetchStats: vi.fn() }) }));

vi.mock("../scout.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createScoutClient: () => ({ streamGames, fetchGames: vi.fn() }) };
});

import { createScoutView } from "./scout.js";

function makeEl(id, props = {}) {
  return {
    id, value: "", textContent: "0", disabled: false, hidden: false, innerHTML: "",
    dataset: {}, classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    focus: vi.fn(), addEventListener: vi.fn(), ...props,
  };
}

// Mirror the screenshot: white-side opponent, each line a single deep (16-ply) game.
const DEEP_LINES = [
  ["d2d4","g8f6","c2c4","e7e6","b1c3","d7d5","g1f3","c7c6","c1g5","b8d7","e2e3","d8a5","f1d3","f8b4","d1c2"],
  ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","g1f3","f8e7","c1g5","e8g8","c4d5","f6d5","e2e3","e7g5","f3g5"],
  ["d2d4","g8f6","c1g5","e7e6","e2e4","h7h6","g5f6","d8f6","e4e5","f6d8","g1f3","d7d6","c2c3","b8c6","e5d6"],
  ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","h2h4","e8g8","e2e4","e7e6","f1e2","d7d5","c4d5","e6d5","e4e5"],
  ["d2d4","d7d5","c1g5","g8f6","g5f6","e7f6","c2c4","c7c5","c4d5","d8d5","b1c3","d5d4","d1d4"],
  ["d2d4","d7d5","c2c4","c7c6","b1c3","g8f6","g1f3","d5c4","e2e4","b7b5","e4e5","f6d5","a2a4","e7e6","a4b5"],
];
function weaknessGames() {
  return DEEP_LINES.map((ucis, i) => ({
    gameId: `w-${i}`,
    color: "white",
    score: i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 0.5,
    ucis,
    sans: ucis.map((u) => u), // sans irrelevant to FEN/key matching
    datestamp: 1000 + i,
    speed: "blitz",
    rating: 1800,
  }));
}

describe("scout maia enrichment orchestration", () => {
  let elements;
  let view;

  beforeEach(() => {
    vi.useFakeTimers();
    wdlReadMock.mockClear();
    streamGames.mockReset();
    streamGames.mockImplementation(async (_u, opts = {}) => {
      for (const g of weaknessGames()) opts.onGame?.(g);
      return { accepted: 12, lastDatestamp: 1000 };
    });

    elements = new Map();
    const card = { classList: { toggle: vi.fn() } };
    globalThis.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: (sel) => (sel === ".replay-card-scout" ? card : null),
    };
    elements.set("scout-username", makeEl("scout-username", { value: "rival" }));
    elements.set("scout-color", makeEl("scout-color", { value: "white" }));
    elements.set("scout-btn", makeEl("scout-btn"));
    elements.set("scout-reset-btn", makeEl("scout-reset-btn"));
    elements.set("scout-live-count", makeEl("scout-live-count"));
    elements.set("scout-results", makeEl("scout-results", { querySelectorAll: () => [], scrollTop: 0 }));
    elements.set("scout-profile", makeEl("scout-profile", { hidden: true }));

    view = createScoutView({
      escapeHtml: (s) => s, setStatus: vi.fn(), switchView: vi.fn(),
      api: vi.fn(async (url) => (url === "/api/repertoires" ? { repertoires: [] } : { nodes: [{ id: "root", depth: 0, parent_id: null, uci: null }] })),
      showInputModal: vi.fn(), createRepertoirePrompt: vi.fn(), editRepertoire: vi.fn(),
      boardAfterMove: vi.fn(), buildProvisionalNode: vi.fn(), hardFlushBuild: vi.fn(),
      selectBuildNode: vi.fn(), resolveBuildId: vi.fn(), setBuildSync: vi.fn(),
      jobToast: { isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), completeJob: vi.fn() },
      parseFenBoard: vi.fn(() => ({})), pieceSvg: vi.fn(() => ""),
      getBuildState: vi.fn(), getBuildNodeById: vi.fn(), setBuildPending: vi.fn(), pushBuildNode: vi.fn(),
    });
    view.bindControls();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.document;
  });

  async function flushDeferredTimers() {
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runOnlyPendingTimersAsync();
  }

  it("enriches displayed prep rows with Maia after a clean stream end", async () => {
    const runPromise = view.runScout();
    await vi.runOnlyPendingTimersAsync();
    await runPromise;
    await flushDeferredTimers();

    const results = elements.get("scout-results");
    expect(wdlReadMock.mock.calls.length).toBeGreaterThan(0);
    expect(results.innerHTML).toContain("scout-maia-estimate");
    expect(results.innerHTML).toContain("score/WDL are Maia estimates");
  });

  // Regression: a Lichess NDJSON stream that drops mid-fetch (non-abort) AFTER games
  // were rendered must still run the deferred Maia/explorer/engine enrichment. The
  // streaming loop suppresses enrichment (it only fires on a non-streaming render), and
  // before the fix the error path settled to "paused" without ever triggering one — so
  // the report was stuck on empirical-only scores with the bare "empirical score/WDL"
  // note (Scout showing zero Maia, the reported symptom).
  it("still enriches with Maia when the stream errors after games arrive", async () => {
    wdlReadMock.mockClear();
    streamGames.mockReset();
    streamGames.mockImplementation(async (_u, opts = {}) => {
      // Deliver exactly RENDER_FORCE_EVERY_INITIAL (25) games so the LAST streamed
      // render is forced+synchronous, leaving renderTimer=null at error time — the
      // condition under which no leftover render timer would rescue enrichment.
      const base = weaknessGames();
      for (let i = 0; i < 25; i += 1) {
        const g = base[i % base.length];
        opts.onGame?.({ ...g, gameId: `we-${i}`, datestamp: 1000 + i });
      }
      throw new Error("network error: stream interrupted");
    });

    const runPromise = view.runScout();
    await vi.runOnlyPendingTimersAsync();
    await runPromise;
    await flushDeferredTimers();

    const html = elements.get("scout-results").innerHTML;
    expect(wdlReadMock.mock.calls.length).toBeGreaterThan(0);
    expect(html).toContain("scout-maia-estimate");
  });
});
