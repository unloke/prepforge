import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamGames = vi.fn();
const pendingExplorerFetches = [];

function explorerRead(label) {
  return {
    available: true,
    theoryDeviation: {
      available: true,
      items: [
        {
          label,
          moveSan: "e4",
          moveUci: "e2e4",
          opponentSharePct: 50,
          mastersSharePct: 10,
          gapPct: 40,
          games: 4,
          bookStatus: "mainline",
        },
      ],
      confidence: { level: "low", label: "low confidence", n: 4 },
      excludedLowSample: 0,
      mastersProbes: 1,
    },
    poolComparison: { available: false, items: [], confidence: { level: "none", label: "no data", n: 0 } },
    rareWeapons: { available: false, items: [], confidence: { level: "none", label: "no data", n: 0 } },
    offBook: { available: false, items: [], sharePct: 0, games: 0, confidence: { level: "none", n: 0 } },
    lowPopularity: { available: false, items: [], confidence: { level: "none", n: 0 } },
    probes: 1,
    mastersFens: 1,
  };
}

vi.mock("../scout-explorer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    collectExplorerProbePositions: vi.fn(() => [
      {
        fen: "start",
        parentUcis: [],
        moveUci: "e2e4",
        moveSan: "e4",
        opponentShare: 0.5,
        opponentGames: 5,
        opponentScorePct: 55,
        ply: 1,
      },
    ]),
    fetchExplorerReads: vi.fn(
      () =>
        new Promise((resolve) => {
          pendingExplorerFetches.push(resolve);
        }),
    ),
  };
});

vi.mock("../explorer.js", () => ({
  createExplorerClient: () => ({
    fetchStats: vi.fn(),
  }),
}));

vi.mock("../scout.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createScoutClient: () => ({ streamGames, fetchGames: vi.fn() }),
  };
});

import { createScoutView } from "./scout.js";

const RENDER_DEBOUNCE_MS = 400;
const EXPLORER_ENRICH_DEBOUNCE_MS = 800;

function makeEl(id, props = {}) {
  return {
    id,
    value: "",
    textContent: "0",
    disabled: false,
    hidden: false,
    innerHTML: "",
    dataset: {},
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    focus: vi.fn(),
    addEventListener: vi.fn(),
    ...props,
  };
}

function resolveNextExplorerFetch(label) {
  const resolve = pendingExplorerFetches.shift();
  expect(resolve, `expected a pending explorer fetch for ${label}`).toBeDefined();
  resolve(explorerRead(label));
}

function profileClickHandler(profileEl) {
  const call = profileEl.addEventListener.mock.calls.find(([event]) => event === "click");
  expect(call).toBeDefined();
  return call[1];
}

describe("scout explorer enrichment generation", () => {
  let elements;
  let view;
  let streamOnGame;

  beforeEach(() => {
    vi.useFakeTimers();
    pendingExplorerFetches.length = 0;
    streamOnGame = null;

    streamGames.mockReset();
    streamGames.mockImplementation(async (_username, opts = {}) => {
      streamOnGame = opts.onGame;
      streamOnGame?.({
        gameId: "g1",
        color: "white",
        score: 1,
        ucis: ["e2e4"],
        sans: ["e4"],
        datestamp: 1000,
        speed: "blitz",
        rating: 1500,
      });
      return { accepted: 1, lastDatestamp: 1000 };
    });

    elements = new Map();
    const card = { classList: { toggle: vi.fn() } };
    globalThis.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: (sel) => (sel === ".replay-card-scout" ? card : null),
    };

    elements.set("scout-username", makeEl("scout-username", { value: "rival" }));
    elements.set("scout-color", makeEl("scout-color", { value: "both" }));
    elements.set("scout-btn", makeEl("scout-btn"));
    elements.set("scout-reset-btn", makeEl("scout-reset-btn"));
    elements.set("scout-live-count", makeEl("scout-live-count"));
    elements.set(
      "scout-results",
      makeEl("scout-results", { querySelectorAll: () => [], scrollTop: 0 }),
    );
    elements.set("scout-profile", makeEl("scout-profile", { hidden: true }));

    view = createScoutView({
      escapeHtml: (s) => s,
      setStatus: vi.fn(),
      switchView: vi.fn(),
      api: vi.fn(async (url) => {
        if (url === "/api/repertoires") return { repertoires: [] };
        return { nodes: [{ id: "root", depth: 0, parent_id: null, uci: null }] };
      }),
      showInputModal: vi.fn(),
      createRepertoirePrompt: vi.fn(),
      editRepertoire: vi.fn(),
      boardAfterMove: vi.fn(),
      buildProvisionalNode: vi.fn(),
      hardFlushBuild: vi.fn(),
      selectBuildNode: vi.fn(),
      resolveBuildId: vi.fn(),
      setBuildSync: vi.fn(),
      jobToast: { isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), completeJob: vi.fn() },
      parseFenBoard: vi.fn(() => ({})),
      pieceSvg: vi.fn(() => ""),
      getBuildState: vi.fn(),
      getBuildNodeById: vi.fn(),
      setBuildPending: vi.fn(),
      pushBuildNode: vi.fn(),
    });
    view.bindControls();
  });

  afterEach(() => {
    const resetHandler = elements.get("scout-reset-btn")?.addEventListener?.mock?.calls?.[0]?.[1];
    if (resetHandler) resetHandler();
    vi.useRealTimers();
    delete globalThis.document;
  });

  async function startScoutAndBeginExplorerFetch() {
    const runPromise = view.runScout();
    await vi.runOnlyPendingTimersAsync();
    await runPromise;
    if (pendingExplorerFetches.length === 0) {
      await vi.advanceTimersByTimeAsync(EXPLORER_ENRICH_DEBOUNCE_MS);
    }
    expect(pendingExplorerFetches).toHaveLength(1);
  }

  it("drops a stale All-speed explorer response after switching to Blitz", async () => {
    await startScoutAndBeginExplorerFetch();

    const profileEl = elements.get("scout-profile");
    const onProfileClick = profileClickHandler(profileEl);
    onProfileClick({
      target: {
        dataset: { speed: "blitz" },
        closest(sel) {
          return sel === ".scout-speed-chip" ? this : null;
        },
      },
    });

    resolveNextExplorerFetch("STALE_ALL");
    await vi.runOnlyPendingTimersAsync();

    const results = elements.get("scout-results");
    expect(results.innerHTML).not.toContain("STALE_ALL");

    await vi.advanceTimersByTimeAsync(EXPLORER_ENRICH_DEBOUNCE_MS);
    expect(pendingExplorerFetches).toHaveLength(1);
    resolveNextExplorerFetch("FRESH_BLITZ");
    await vi.runOnlyPendingTimersAsync();

    expect(results.innerHTML).toContain("FRESH_BLITZ");
  });

  it("drops a stale explorer response when a new streamed game arrives", async () => {
    await startScoutAndBeginExplorerFetch();

    streamOnGame?.({
      gameId: "g2",
      color: "white",
      score: 0,
      ucis: ["d2d4"],
      sans: ["d4"],
      datestamp: 2000,
      speed: "blitz",
      rating: 1500,
    });
    await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS);

    resolveNextExplorerFetch("STALE_G1");
    await vi.runOnlyPendingTimersAsync();

    const results = elements.get("scout-results");
    expect(results.innerHTML).not.toContain("STALE_G1");

    await vi.advanceTimersByTimeAsync(EXPLORER_ENRICH_DEBOUNCE_MS);
    expect(pendingExplorerFetches).toHaveLength(1);
    resolveNextExplorerFetch("FRESH_G2");
    await vi.runOnlyPendingTimersAsync();

    expect(results.innerHTML).toContain("FRESH_G2");
  });
});