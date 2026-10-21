import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamGames = vi.fn();

vi.mock("../scout.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createScoutClient: () => ({ streamGames, fetchGames: vi.fn() }),
  };
});

import { createScoutView } from "./scout.js";

// The "Playing as" scope is read once, when the run starts (views/scout.js:
// startScout reads scout-color.value before the repertoire load). While the
// scout is initialising, the select must not accept a change the run would
// silently ignore.

function makeEl(id, props = {}) {
  return {
    id,
    value: "",
    textContent: "0",
    disabled: false,
    hidden: false,
    get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
    dataset: {},
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    focus: vi.fn(),
    addEventListener: vi.fn(),
    ...props,
  };
}

describe("Scout colour scope control", () => {
  let elements;
  let api;
  let view;

  beforeEach(() => {
    streamGames.mockReset();
    streamGames.mockImplementation(async (username, opts = {}) => {
      opts.onGame?.({
        gameId: "live1", color: "white", score: 1, ucis: ["e2e4"], sans: ["e4"],
        datestamp: 1000, speed: "blitz", rating: 1500,
      });
      return { accepted: 1, lastDatestamp: 1000 };
    });
    elements = new Map();
    const card = { classList: { toggle: vi.fn() } };
    globalThis.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: (sel) => (sel === ".replay-card-scout" ? card : null),
    };
    elements.set("scout-color", makeEl("scout-color", { value: "both" }));
    elements.set("scout-btn", makeEl("scout-btn"));
    elements.set("scout-reset-btn", makeEl("scout-reset-btn"));
    elements.set("scout-live-count", makeEl("scout-live-count"));
    elements.set("scout-results", makeEl("scout-results", { querySelectorAll: () => [], scrollTop: 0 }));
    elements.set("scout-profile", makeEl("scout-profile", { hidden: true }));
    api = vi.fn(async (url) => {
      if (url === "/api/repertoires") return { repertoires: [] };
      return { nodes: [] };
    });
    view = createScoutView({
      setStatus: vi.fn(),
      switchView: vi.fn(),
      api,
      showInputModal: vi.fn(),
      createRepertoirePrompt: vi.fn(),
      editRepertoire: vi.fn(),
      boardAfterMove: vi.fn(),
      buildProvisionalNode: vi.fn(),
      hardFlushBuild: vi.fn(),
      selectBuildNode: vi.fn(),
      resolveBuildId: vi.fn(),
      setBuildSync: vi.fn(),
      notices: { isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), completeJob: vi.fn() },
      parseFenBoard: vi.fn(() => ({})),
      pieceSvg: vi.fn(() => ""),
      getBuildState: vi.fn(),
      getBuildNodeById: vi.fn(),
      queueBuildAdd: vi.fn(),
      scoutPickedUsernames: () => ["rival"],
    });
    view.bindControls();
  });

  afterEach(() => {
    delete globalThis.document;
  });

  it("takes the scope when no scout has run", () => {
    expect(elements.get("scout-color").disabled).toBe(false);
  });

  it("locks the scope while the scout is initialising", async () => {
    let resolveReps;
    api.mockImplementation(async (url) => {
      if (url === "/api/repertoires") return new Promise((resolve) => { resolveReps = resolve; });
      return { nodes: [] };
    });
    const running = view.runScout();
    await vi.waitFor(() => expect(api).toHaveBeenCalled());
    // The repertoire load is in flight: the scope the run already read must
    // not be changeable under it.
    expect(elements.get("scout-color").disabled).toBe(true);
    resolveReps({ repertoires: [] });
    await running;
  });

  it("keeps the scope locked while the scout streams", async () => {
    let release;
    streamGames.mockImplementation(async (username, opts = {}) => {
      await new Promise((resolve) => { release = resolve; });
      opts.onGame?.({ gameId: "live1", color: "white", score: 1, ucis: ["e2e4"], sans: ["e4"], datestamp: 1000, speed: "blitz", rating: 1500 });
      return { accepted: 1, lastDatestamp: 1000 };
    });
    const running = view.runScout();
    await vi.waitFor(() => expect(streamGames).toHaveBeenCalled());
    expect(elements.get("scout-color").disabled).toBe(true);
    release();
    await running;
  });
});
