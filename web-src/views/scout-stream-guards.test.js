import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// While games stream, only the empirical report is drawn: Stockfish, Maia and the
// explorer wait for the stream to stop. These cover the ways around that gate: a
// Resume / Load older while enrichment of the paused report was still running, a
// speed chip pressed mid-stream, and Deep scan pressed mid-stream.

const streamGames = vi.fn();
const wdlReadMock = vi.fn(async () => ({ wdl: { win: 300, draw: 300, loss: 400 } }));
const fetchExplorerReads = vi.fn(async () => ({ available: false }));

vi.mock("../engine/maia3-provider.js", () => ({
  getSharedMaia3Provider: () => ({ wdlRead: wdlReadMock, state: "ready" }),
}));
vi.mock("../scout-explorer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  collectExplorerProbePositions: vi.fn(() => [{ fen: "x" }]),
  fetchExplorerReads: (...args) => fetchExplorerReads(...args),
}));
vi.mock("../explorer.js", () => ({ createExplorerClient: () => ({ fetchStats: vi.fn() }) }));
vi.mock("../scout.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createScoutClient: () => ({ streamGames }),
}));
vi.mock("../scout-prefilter.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runStockfishPrefilter: vi.fn(),
}));

globalThis.window = globalThis.window || {};
globalThis.window.location = { search: "" };

import { createScoutView } from "./scout.js";
import { runStockfishPrefilter } from "../scout-prefilter.js";

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
  ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "g1f3", "f8e7"],
  ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6"],
];
function games(prefix, stampBase, speed = "blitz") {
  return LINES.flatMap((ucis, i) => Array.from({ length: 4 }, (_, copy) => ({
    gameId: `${prefix}-${i}-${copy}`, color: "white", score: i === 0 ? 0 : 0.5, ucis, sans: ucis,
    openingUcis: ucis, openingSans: ucis, openingEndPly: ucis.length, totalPly: ucis.length,
    clockAfterPly: ucis.map(() => null), timeControl: { baseSeconds: 180, incrementSeconds: 2 },
    nextOwnThinkSeconds: [], datestamp: stampBase - i * 10 - copy, speed: copy % 2 ? "rapid" : speed,
    rating: 1800, opponentRating: 1700,
  })));
}

describe("scout enrichment waits for the stream", () => {
  let elements;
  let view;
  let notices;

  beforeEach(() => {
    vi.useFakeTimers();
    streamGames.mockReset();
    wdlReadMock.mockClear();
    fetchExplorerReads.mockClear();
    runStockfishPrefilter.mockReset();
    runStockfishPrefilter.mockImplementation(async (lines) => ({
      ranked: lines.map((line) => ({ line, prefilterScore: 10 })), pool: lines, maiaLines: lines, cancelled: false,
    }));
    elements = new Map();
    const card = { classList: { toggle: vi.fn() } };
    globalThis.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: (sel) => (sel === ".replay-card-scout" ? card : null),
    };
    for (const id of ["scout-btn", "scout-reset-btn", "scout-live-count", "scout-results"]) elements.set(id, makeEl(id));
    elements.set("scout-color", makeEl("scout-color", { value: "white" }));
    elements.set("scout-profile", makeEl("scout-profile", { hidden: true }));
    notices = { isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), completeJob: vi.fn(), cancelJob: vi.fn(), failJob: vi.fn() };
    view = createScoutView({
      setStatus: vi.fn(), switchView: vi.fn(),
      api: vi.fn(async (url) => (url === "/api/repertoires" ? { repertoires: [] } : { nodes: [] })),
      notices, parseFenBoard: vi.fn(() => ({})), pieceSvg: vi.fn(() => ""), getBuildState: vi.fn(),
      scoutPickedUsernames: () => ["rival"],
    });
    view.bindControls();
  });

  afterEach(() => {
    view.discardReport();
    vi.useRealTimers();
    delete globalThis.document;
  });

  // A stream the test ends by hand, after emitting `batch` games.
  function heldStream(batch) {
    let finish;
    streamGames.mockImplementationOnce((_u, opts = {}) => new Promise((resolve) => {
      for (const g of batch) opts.onGame?.(g);
      finish = () => resolve({ accepted: batch.length, received: batch.length, lastDatestamp: 1 });
    }));
    return () => finish();
  }

  function profileClick(selector, dataset = {}) {
    const handler = elements.get("scout-profile").addEventListener.mock.calls.find(([type]) => type === "click")[1];
    const target = { dataset, closest: (sel) => (sel === selector ? target : null) };
    handler({ target });
  }

  it("Load older cancels the paused report's Stockfish read and runs no Maia mid-stream", async () => {
    // First batch fills (500 received): the run pauses on "Load older".
    streamGames.mockImplementationOnce(async (_u, opts = {}) => {
      for (const g of games("a", 100_000)) opts.onGame?.(g);
      return { accepted: 12, received: 500, lastDatestamp: 99_000 };
    });
    let cancelPrefilter;
    let finishPrefilter;
    runStockfishPrefilter.mockImplementationOnce((lines, opts) => new Promise((resolve) => {
      cancelPrefilter = opts.shouldCancel;
      finishPrefilter = () => resolve({ ranked: lines.map((line) => ({ line, prefilterScore: 10 })), pool: lines, maiaLines: lines });
    }));
    await view.runScout();
    await vi.advanceTimersByTimeAsync(500);
    expect(cancelPrefilter).toBeTypeOf("function");
    expect(cancelPrefilter()).toBe(false);

    const finishStream = heldStream(games("b", 90_000));
    const resumed = view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelPrefilter()).toBe(true);

    finishPrefilter();
    await vi.advanceTimersByTimeAsync(3000);
    expect(wdlReadMock).not.toHaveBeenCalled();
    finishStream();
    await resumed;
  });

  it("a speed chip pressed mid-stream starts no Stockfish or explorer read until the stream ends", async () => {
    const finishStream = heldStream(games("a", 100_000));
    const run = view.runScout();
    await vi.advanceTimersByTimeAsync(0);
    profileClick(".scout-speed-chip", { speed: "rapid" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(runStockfishPrefilter).not.toHaveBeenCalled();
    expect(fetchExplorerReads).not.toHaveBeenCalled();

    finishStream();
    await run;
    await vi.advanceTimersByTimeAsync(3000);
    expect(runStockfishPrefilter).toHaveBeenCalled();
  });

  it("Deep scan waits for the stream: the button is disabled and a press starts no job", async () => {
    const finishStream = heldStream(games("a", 100_000));
    const run = view.runScout();
    await vi.advanceTimersByTimeAsync(2000);
    expect(elements.get("scout-profile").innerHTML).toMatch(/id="scout-deep-scan-btn"[^>]*disabled/);
    profileClick("#scout-deep-scan-btn");
    await vi.advanceTimersByTimeAsync(0);
    expect(notices.startJob).not.toHaveBeenCalled();
    finishStream();
    await run;
    expect(elements.get("scout-profile").innerHTML).not.toMatch(/id="scout-deep-scan-btn"[^>]*disabled/);
  });

  it("a failed Stockfish read is logged, stated in the report, and can be retried", async () => {
    // Was: the catch swallowed the error and marked the scope settled, so the
    // plan stayed on game results with no word and no way to read again.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runStockfishPrefilter.mockRejectedValueOnce(new Error("engine crashed"));
    streamGames.mockImplementationOnce(async (_u, opts = {}) => {
      for (const g of games("a", 100_000)) opts.onGame?.(g);
      return { accepted: 12, received: 12, lastDatestamp: 99_000 };
    });
    await view.runScout();
    await vi.advanceTimersByTimeAsync(3000);
    expect(warn).toHaveBeenCalledWith("[scout-prefilter] failed:", "engine crashed");
    const results = elements.get("scout-results");
    expect(results.innerHTML).toContain("data-scout-retry-prefilter");
    const calls = runStockfishPrefilter.mock.calls.length;

    const click = results.addEventListener.mock.calls.find(([type]) => type === "click")[1];
    const target = { closest: (sel) => (sel === "[data-scout-retry-prefilter]" ? target : null) };
    await click({ target });
    await vi.advanceTimersByTimeAsync(3000);
    expect(runStockfishPrefilter.mock.calls.length).toBeGreaterThan(calls);
    expect(results.innerHTML).not.toContain("data-scout-retry-prefilter");
    warn.mockRestore();
  });

  it("Reset and a new Start forget the open colour tab", async () => {
    streamGames.mockResolvedValue({ accepted: 0, received: 0, lastDatestamp: null });
    await view.runScout();
    const results = elements.get("scout-results");
    results.dataset.scoutTab = "black";
    view.discardReport();
    expect(results.dataset.scoutTab).toBeUndefined();

    results.dataset.scoutTab = "black";
    await view.runScout();
    expect(results.dataset.scoutTab).toBeUndefined();
  });
});
