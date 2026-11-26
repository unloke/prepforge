import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A Start whose sources and colour match a saved run opens that run at once and
// asks Lichess only for the games played since; Load older then pages on from
// the saved oldest game, and a refresh that comes back full (more new games than
// one batch) drops the saved games behind the gap.

const streamGames = vi.fn();

vi.mock("../engine/maia3-provider.js", () => ({
  getSharedMaia3Provider: () => ({ wdlRead: vi.fn(async () => ({ wdl: { win: 300, draw: 300, loss: 400 } })), state: "ready" }),
}));
vi.mock("../scout-explorer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  collectExplorerProbePositions: vi.fn(() => []),
  fetchExplorerReads: vi.fn(async () => ({ available: false })),
}));
vi.mock("../explorer.js", () => ({ createExplorerClient: () => ({ fetchStats: vi.fn() }) }));
vi.mock("../scout.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createScoutClient: () => ({ streamGames }),
}));
vi.mock("../scout-prefilter.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runStockfishPrefilter: vi.fn(async (lines) => ({ ranked: [], pool: lines, maiaLines: [], cancelled: false })),
}));

globalThis.window = globalThis.window || {};
globalThis.window.location = { search: "" };

import { createScoutView } from "./scout.js";
import { compactScoutGame, scoutHistoryKey } from "../scout-history.js";

function makeEl(id, props = {}) {
  return {
    id, value: "", textContent: "0", disabled: false, hidden: false,
    get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
    dataset: {}, classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    focus: vi.fn(), addEventListener: vi.fn(), querySelectorAll: () => [], querySelector: () => null,
    scrollTop: 0, ...props,
  };
}

const LINES = [
  ["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "d7d5", "g1f3", "c7c6"],
  ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6"],
];
function games(prefix, stampBase, count = 6) {
  return Array.from({ length: count }, (_, i) => {
    const ucis = LINES[i % 2];
    return {
      gameId: `${prefix}-${i}`, color: "white", score: 0.5, ucis, sans: ucis, openingUcis: ucis, openingSans: ucis,
      openingEndPly: ucis.length, totalPly: ucis.length, clockAfterPly: ucis.map(() => null),
      timeControl: { baseSeconds: 180, incrementSeconds: 2 }, datestamp: stampBase - i * 10, speed: "blitz", rating: 1800,
    };
  });
}

function savedRun({ full = true } = {}) {
  const old = games("s", 100_000).map((g) => ({ ...g, scoutUsername: "rival" }));
  return {
    key: scoutHistoryKey(["rival"], "white"), usernames: ["rival"], label: "rival", color: "white",
    savedAt: 1, gameCount: old.length, games: old.map(compactScoutGame),
    sources: { rival: { oldest: 99_950, newest: 100_000, exhausted: !full, full } },
  };
}

describe("a Start over a saved run", () => {
  let elements;
  let view;
  let store;
  let history;

  function mount(usernames = ["rival"]) {
    view = createScoutView({
      setStatus: vi.fn(), switchView: vi.fn(),
      api: vi.fn(async (url) => (url === "/api/repertoires" || url === "/api/scout/trees" ? { repertoires: [] } : { nodes: [] })),
      notices: { isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), completeJob: vi.fn(), cancelJob: vi.fn(), failJob: vi.fn() },
      parseFenBoard: vi.fn(() => ({})), pieceSvg: vi.fn(() => ""), getBuildState: vi.fn(),
      scoutPickedUsernames: () => usernames,
      scoutHistory: history, currentOwnerId: () => "u1", onScoutHistorySaved: vi.fn(),
    });
    view.bindControls();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    streamGames.mockReset();
    elements = new Map();
    const card = { classList: { toggle: vi.fn() } };
    globalThis.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: (sel) => (sel === ".replay-card-scout" ? card : null),
    };
    for (const id of ["scout-btn", "scout-reset-btn", "scout-live-count", "scout-results"]) elements.set(id, makeEl(id));
    elements.set("scout-color", makeEl("scout-color", { value: "white" }));
    elements.set("scout-profile", makeEl("scout-profile", { hidden: true }));
    store = new Map();
    history = {
      key: scoutHistoryKey,
      load: vi.fn(async (_owner, key) => store.get(key) ?? null),
      save: vi.fn(async (_owner, run) => { store.set(run.key, structuredClone(run)); return true; }),
    };
  });

  afterEach(() => {
    view?.discardReport();
    vi.useRealTimers();
    delete globalThis.document;
  });

  const lastSave = () => history.save.mock.calls.at(-1)[1];

  it("renders the saved games first, streams only newer ones and merges them by game id", async () => {
    store.set(savedRun().key, savedRun());
    mount();
    let reportAtStream = "";
    streamGames.mockImplementationOnce(async (_user, opts) => {
      reportAtStream = elements.get("scout-results").innerHTML;
      // Two new games, and the boundary game again (since is inclusive of its second).
      for (const g of [...games("n", 100_100, 2), games("s", 100_000, 1)[0]]) opts.onGame(g);
      return { accepted: 2, received: 3, lastDatestamp: 100_000 };
    });
    await view.runScout();
    await vi.advanceTimersByTimeAsync(0);

    const opts = streamGames.mock.calls[0][1];
    expect(opts.since).toBe(100_001);
    expect(opts.until).toBeUndefined();
    expect(reportAtStream).not.toBe("");
    expect(elements.get("scout-live-count").textContent).toBe("8");
    const saved = lastSave();
    expect(saved.gameCount).toBe(8);
    expect(saved.games[0].gameId).toBe("n-0");
    expect(saved.games.map((g) => g.datestamp)).toEqual([...saved.games.map((g) => g.datestamp)].sort((a, b) => b - a));
    expect(saved.sources.rival).toMatchObject({ newest: 100_100, oldest: 99_950, full: true });
  });

  it("Load older then pages on from the saved oldest game", async () => {
    store.set(savedRun().key, savedRun());
    mount();
    streamGames.mockResolvedValueOnce({ accepted: 0, received: 0, lastDatestamp: null });
    await view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    streamGames.mockResolvedValueOnce({ accepted: 0, received: 0, lastDatestamp: null });
    await view.runScout(); // paused (the saved run had more): Load older
    await vi.advanceTimersByTimeAsync(0);
    const opts = streamGames.mock.calls[1][1];
    expect(opts.until).toBe(99_950);
    expect(opts.since).toBeUndefined();
  });

  it("a source read to its end when saved is not asked for older games again", async () => {
    store.set(savedRun().key, savedRun({ full: false }));
    mount();
    streamGames.mockResolvedValueOnce({ accepted: 0, received: 0, lastDatestamp: null });
    await view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    expect(streamGames).toHaveBeenCalledTimes(1);
    expect(lastSave().sources.rival).toMatchObject({ exhausted: true, newest: 100_000 });
  });

  it("a refresh that comes back full drops the saved games behind the gap", async () => {
    store.set(savedRun().key, savedRun());
    mount();
    streamGames.mockImplementationOnce(async (_user, opts) => {
      for (const g of games("n", 200_000, 3)) opts.onGame(g);
      return { accepted: 3, received: 500, lastDatestamp: 150_000 };
    });
    await view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    expect(elements.get("scout-live-count").textContent).toBe("3");
    expect(lastSave().games.map((g) => g.gameId)).toEqual(["n-0", "n-1", "n-2"]);
    streamGames.mockResolvedValueOnce({ accepted: 0, received: 0, lastDatestamp: null });
    await view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    expect(streamGames.mock.calls[1][1].until).toBe(150_000);
  });

  it("a stopped refresh is saved as still owed, and Resume asks for the newer games again", async () => {
    store.set(savedRun().key, savedRun());
    mount();
    streamGames.mockImplementationOnce((_user, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("stop"), { name: "AbortError" })));
    }));
    const started = view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    await view.runScout(); // Stop
    await started;
    await vi.advanceTimersByTimeAsync(0);
    expect(lastSave().sources.rival.newest).toBe(100_000);
    streamGames.mockResolvedValueOnce({ accepted: 0, received: 0, lastDatestamp: null });
    await view.runScout(); // Resume
    await vi.advanceTimersByTimeAsync(0);
    expect(streamGames.mock.calls[1][1].since).toBe(100_001);
  });

  it("without a saved run, Start streams from the newest game and saves the run", async () => {
    mount();
    streamGames.mockImplementationOnce(async (_user, opts) => {
      for (const g of games("f", 50_000)) opts.onGame(g);
      return { accepted: 6, received: 6, lastDatestamp: 49_950 };
    });
    await view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    expect(streamGames.mock.calls[0][1]).toMatchObject({ until: undefined });
    expect(streamGames.mock.calls[0][1].since).toBeUndefined();
    expect(lastSave()).toMatchObject({ gameCount: 6, sources: { rival: { oldest: 49_950, newest: 50_000, exhausted: true } } });
  });

  it("a history that fails leaves Scout as it was", async () => {
    history.load = vi.fn(async () => { throw new Error("idb gone"); });
    history.save = vi.fn(async () => false);
    mount();
    streamGames.mockImplementationOnce(async (_user, opts) => {
      for (const g of games("f", 50_000)) opts.onGame(g);
      return { accepted: 6, received: 6, lastDatestamp: 49_950 };
    });
    await view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    expect(streamGames).toHaveBeenCalledTimes(1);
    expect(elements.get("scout-live-count").textContent).toBe("6");
  });
  // Review of #328: the saved newest game is stamped to the second, so the refresh
  // ("since" newest + 1 ms) returns it again. With a full batch that read as a gap:
  // the deduped newest game was dropped with the other saved games, and Load older
  // (from the batch's oldest game, that one) could never bring it back.
  it("a full refresh that reaches the newest saved game keeps it and the saved games", async () => {
    store.set(savedRun().key, savedRun());
    mount();
    streamGames.mockImplementationOnce(async (_user, opts) => {
      for (const g of games("n", 200_000, 499)) opts.onGame(g);
      opts.onGame(games("s", 100_000, 1)[0]);
      return { accepted: 499, received: 500, lastDatestamp: 100_000 };
    });
    await view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    expect(elements.get("scout-live-count").textContent).toBe("505");
    const saved = lastSave();
    expect(saved.games.map((g) => g.gameId)).toContain("s-0");
    expect(saved.sources.rival).toMatchObject({ oldest: 99_950, newest: 200_000 });
    streamGames.mockResolvedValueOnce({ accepted: 0, received: 0, lastDatestamp: null });
    await view.runScout(); // Load older goes on from the saved oldest game
    await vi.advanceTimersByTimeAsync(0);
    expect(streamGames.mock.calls[1][1].until).toBe(99_950);
  });

  // Review of #328: a source that had no games when saved was stored as read to its
  // end with no newest game, so a reopen never asked it again.
  it("a source that had no games when saved is read again on reopen", async () => {
    const run = savedRun();
    run.key = scoutHistoryKey(["rival", "quiet"], "white");
    run.usernames = ["rival", "quiet"];
    run.sources.quiet = { oldest: null, newest: null, exhausted: true, full: false };
    store.set(run.key, run);
    mount(["rival", "quiet"]);
    streamGames.mockResolvedValue({ accepted: 0, received: 0, lastDatestamp: null });
    await view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    const asked = Object.fromEntries(streamGames.mock.calls.map(([user, opts]) => [user, opts]));
    expect(Object.keys(asked).sort()).toEqual(["quiet", "rival"]);
    expect(asked.quiet.since).toBeUndefined();
    expect(asked.quiet.until).toBeUndefined();
    expect(asked.rival.since).toBe(100_001);
  });
});
