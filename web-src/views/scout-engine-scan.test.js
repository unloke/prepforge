import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamGames = vi.fn();
let resolveDeepScan;
let deepScanLabel = "STALE_SCAN";

vi.mock("../scout-engine.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runScoutDeepScan: vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDeepScan = () =>
            resolve({
              patterns: new Map(),
              scanRecords: [
                {
                  gameId: "stale-game",
                  firstUci: "e2e4",
                  firstSan: "e4",
                  eligibleOpponentPlies: 1,
                  analyzedOpponentPlies: 1,
                  moves: [{ ply: 0, cpLoss: 99, isInaccuracy: true }],
                },
              ],
              gameIds: ["stale-game"],
              speedFilter: "all",
              oppColor: "white",
              eligibleGames: 1,
            });
        }),
    ),
    engineScanPatterns: actual.engineScanPatterns,
    aggregateEngineByFamily: actual.aggregateEngineByFamily,
  };
});

vi.mock("../scout-explorer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    collectExplorerProbePositions: vi.fn(() => []),
    fetchExplorerReads: vi.fn(async () => ({
      available: false,
      mastersByFen: new Map(),
      poolByFen: new Map(),
    })),
  };
});

vi.mock("../explorer.js", () => ({
  createExplorerClient: () => ({ fetchStats: vi.fn() }),
}));

vi.mock("../scout.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createScoutClient: () => ({ streamGames, fetchGames: vi.fn() }),
  };
});

import { runScoutDeepScan } from "../scout-engine.js";
import { createScoutView } from "./scout.js";

const ENGINE_AGG_DEBOUNCE_MS = 400;

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

function profileClickHandler(profileEl) {
  return profileEl.addEventListener.mock.calls.find(([event]) => event === "click")[1];
}

describe("scout deep scan session binding", () => {
  let elements;
  let view;
  let streamOnGame;

  beforeEach(() => {
    vi.useFakeTimers();
    resolveDeepScan = null;
    runScoutDeepScan.mockClear();

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

  async function startScout() {
    const runPromise = view.runScout();
    await vi.runOnlyPendingTimersAsync();
    await runPromise;
  }

  it("drops a stale deep scan after Reset then Start", async () => {
    await startScout();
    const profileEl = elements.get("scout-profile");
    profileEl.hidden = false;

    const onProfileClick = profileClickHandler(profileEl);
    onProfileClick({
      target: {
        closest(sel) {
          return sel === "#scout-deep-scan-btn" ? this : null;
        },
      },
    });
    await vi.runOnlyPendingTimersAsync();
    expect(runScoutDeepScan).toHaveBeenCalled();

    elements.get("scout-reset-btn").addEventListener.mock.calls[0][1]();
    elements.get("scout-username").value = "fresh";
    const freshRun = view.runScout();
    await vi.runOnlyPendingTimersAsync();

    resolveDeepScan?.();
    await vi.runOnlyPendingTimersAsync();
    await freshRun;
    await vi.advanceTimersByTimeAsync(ENGINE_AGG_DEBOUNCE_MS);
    await vi.runOnlyPendingTimersAsync();

    expect(elements.get("scout-results").innerHTML).not.toContain("99 cp");
    expect(elements.get("scout-results").innerHTML).not.toContain("stale-game");
  });

  it("downgrades engine aggregate after a new streamed game arrives", async () => {
    await startScout();

    const profileEl = elements.get("scout-profile");
    profileEl.hidden = false;
    profileClickHandler(profileEl)({
      target: {
        closest(sel) {
          return sel === "#scout-deep-scan-btn" ? this : null;
        },
      },
    });
    await vi.runOnlyPendingTimersAsync();
    resolveDeepScan?.();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(ENGINE_AGG_DEBOUNCE_MS);
    await vi.runOnlyPendingTimersAsync();

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
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(ENGINE_AGG_DEBOUNCE_MS);
    await vi.runOnlyPendingTimersAsync();

    const html = elements.get("scout-results").innerHTML;
    expect(html).toContain("coverage insufficient");
    expect(html).toContain("new games arrived");
    expect(html).not.toContain("Highest ACPL");
  });
});