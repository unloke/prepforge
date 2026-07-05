import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamGames = vi.fn();
const pendingExplorerFetches = [];

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

// This suite exercises the classic v2 prefilter/Maia pipeline (the default Scout UI mode).
globalThis.window = globalThis.window || {};
globalThis.window.location = { search: "" };

import { createScoutView } from "./scout.js";

const RENDER_DEBOUNCE_MS = 400;
const EXPLORER_ENRICH_DEBOUNCE_MS = 800;

function makeEl(id, props = {}) {
  return {
    id,
    value: "",
    textContent: "0",
    disabled: false,
    hidden: true,
    innerHTML: "",
    dataset: {},
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    focus: vi.fn(),
    addEventListener: vi.fn(),
    ...props,
  };
}

function resolveNextExplorerFetch(marker) {
  const resolve = pendingExplorerFetches.shift();
  resolve?.({
    available: false,
    reason: "auth",
    marker,
    mastersByFen: new Map(),
    poolByFen: new Map(),
  });
}

describe("scout refutation render sync", () => {
  let elements;
  let view;
  let streamOnGame;

  beforeEach(() => {
    vi.useFakeTimers();
    pendingExplorerFetches.length = 0;
    streamOnGame = null;
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
      makeEl("scout-results", { querySelectorAll: () => [], scrollTop: 0, innerHTML: "" }),
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
      jobToast: {
        isBusy: () => false,
        startJob: vi.fn(),
        updateJob: vi.fn(),
        completeJob: vi.fn(),
        cancelJob: vi.fn(),
        failJob: vi.fn(),
      },
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

  it("drops a stale explorer generation before refutation gap hints render", async () => {
    await startScoutAndBeginExplorerFetch();

    elements.get("scout-reset-btn").addEventListener.mock.calls[0][1]();
    elements.get("scout-username").value = "fresh";
    const freshRun = view.runScout();
    await vi.runOnlyPendingTimersAsync();

    resolveNextExplorerFetch("STALE_REFUTE_GAP");
    await vi.runOnlyPendingTimersAsync();
    await freshRun;

    const html = elements.get("scout-results").innerHTML;
    expect(html).not.toContain("Connect Lichess account");
  });

  it("renders refutation panel without false-positive hits when engine scan is absent", async () => {
    await startScoutAndBeginExplorerFetch();
    resolveNextExplorerFetch("FRESH");
    await vi.runOnlyPendingTimersAsync();

    const html = elements.get("scout-results").innerHTML;
    expect(html).toContain("scout-ranked-note");
    expect(html).toContain("Engine scan: run Deep scan");
    expect(html).not.toContain("scout-refutation-hit");
    expect(html).not.toContain("STALE_REFUTE_GAP");
  });
});