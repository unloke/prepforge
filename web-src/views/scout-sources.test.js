import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each Scout source pages on its own: its own cursor, its own "older games
// left" state, and a stream of some sources (Retry) leaves the others alone.

const streamGames = vi.fn();

vi.mock("../scout.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createScoutClient: () => ({ streamGames }),
}));

import { createScoutView } from "./scout.js";
import { SCOUT_STREAM_BATCH, recordStreamResults, scoutStreamCapNoteHtml, sourcesToStream } from "./scout-sources.js";

function makeEl(id, props = {}) {
  return {
    id, value: "", textContent: "0", disabled: false, hidden: false,
    get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
    dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, focus() {}, addEventListener: vi.fn(),
    querySelectorAll: () => [], querySelector: () => null, scrollTop: 0, remove() {},
    parentNode: { insertBefore() {} }, ...props,
  };
}

const game = (user, i, stamp) => ({
  gameId: `${user}${i}`, color: "white", score: 1, ucis: ["e2e4"], sans: ["e4"], datestamp: stamp, speed: "blitz", rating: 1500,
});

describe("scout per-source paging", () => {
  let elements;
  let view;
  let retry;

  beforeEach(() => {
    streamGames.mockReset();
    elements = new Map();
    retry = null;
    globalThis.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => ({ classList: { toggle() {} } }),
      createElement: () => makeEl("scout-source-warnings", {
        querySelector: () => ({ addEventListener: (_type, fn) => { retry = fn; } }),
      }),
    };
    for (const id of ["scout-btn", "scout-reset-btn", "scout-live-count", "scout-results", "scout-profile"]) elements.set(id, makeEl(id));
    elements.set("scout-color", makeEl("scout-color", { value: "both" }));
    view = createScoutView({
      setStatus: vi.fn(), switchView: vi.fn(),
      api: async (url) => (url === "/api/repertoires" ? { repertoires: [] } : { nodes: [] }),
      notices: { isBusy: () => false }, parseFenBoard: () => ({}), pieceSvg: () => "", getBuildState: vi.fn(),
      scoutPickedUsernames: () => ["a", "b"],
    });
    view.bindControls();
  });

  afterEach(() => {
    view.discardReport();
    delete globalThis.document;
  });

  // `a` fills its first batch; `b` fails before sending a game, then answers empty.
  function fullAndFailing() {
    let bFails = true;
    streamGames.mockImplementation(async (username, opts) => {
      if (username === "b" && bFails) { bFails = false; throw new Error("network"); }
      if (username === "a" && streamGames.mock.calls.filter(([u]) => u === "a").length === 1) {
        for (let i = 0; i < SCOUT_STREAM_BATCH; i++) opts.onGame(game("a", i, 2_000_000 - i * 1000));
        return { accepted: SCOUT_STREAM_BATCH, received: SCOUT_STREAM_BATCH, lastDatestamp: 1_501_000 };
      }
      return { accepted: 0, received: 0, lastDatestamp: null };
    });
  }

  it("a source that failed before its first game loads older from its own newest game", async () => {
    // Was: b streamed from a's cursor (1501000), skipping all of b's newer games.
    fullAndFailing();
    await view.runScout();
    expect(elements.get("scout-btn").textContent).toBe("Load older");
    await view.runScout();
    const bCalls = streamGames.mock.calls.filter(([u]) => u === "b");
    expect(bCalls).toHaveLength(2);
    expect(bCalls[1][1].until).toBeUndefined();
    expect(streamGames.mock.calls.filter(([u]) => u === "a")[1][1].until).toBe(1_501_000);
  });

  it("Retry of a failed source keeps Load older for a source with older games left", async () => {
    // Was: the retry recomputed batchFull from the retried source alone and the
    // run ended on Start, with a's older games out of reach.
    fullAndFailing();
    await view.runScout();
    expect(retry).toBeTypeOf("function");
    retry();
    await vi.waitFor(() => expect(streamGames).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(elements.get("scout-btn").textContent).toBe("Load older");
  });

  it("Load older skips a source already read to its end", async () => {
    // Was: every Load older asked Lichess again for a source with no older games.
    streamGames.mockImplementation(async (username, opts) => {
      if (username === "a") {
        const n = streamGames.mock.calls.filter(([u]) => u === "a").length;
        for (let i = 0; i < SCOUT_STREAM_BATCH; i++) opts.onGame(game(`a${n}-`, i, 2_000_000 - n * 600_000 - i * 1000));
        return { accepted: SCOUT_STREAM_BATCH, received: SCOUT_STREAM_BATCH, lastDatestamp: 2_000_000 - n * 600_000 - 499_000 };
      }
      opts.onGame(game("b", 0, 1_900_000));
      return { accepted: 1, received: 1, lastDatestamp: 1_900_000 };
    });
    await view.runScout();
    await view.runScout();
    await view.runScout();
    expect(streamGames.mock.calls.map(([u]) => u)).toEqual(["a", "b", "a", "a"]);
  });

  it("states the batch cap with a Load older action while older games are left", async () => {
    fullAndFailing();
    await view.runScout();
    const results = elements.get("scout-results").innerHTML;
    expect(results).toContain(`Read the newest ${SCOUT_STREAM_BATCH} games per account.`);
    expect(results).toContain("data-scout-load-older");
  });
});

describe("recordStreamResults", () => {
  const session = () => ({ oldestDatestampByUser: {}, acceptedByUser: { a: 3 }, sourceStatus: {}, usernames: ["a", "b"] });
  const errorMessage = (reason) => reason.message;

  it("a stopped source can be resumed; one read short of a batch is done", () => {
    const s = session();
    recordStreamResults(s, ["a", "b"], [
      { status: "fulfilled", value: { received: 40, lastDatestamp: 7 } },
      { status: "fulfilled", value: { received: 3, lastDatestamp: null } },
    ], { aborted: [true, false], errorMessage });
    expect(s.sourceProgress).toEqual({
      a: { full: false, stopped: true, exhausted: false },
      b: { full: false, stopped: false, exhausted: true },
    });
    expect(s.hasMore).toBe(true);
    expect(s.batchFull).toBe(false);
    expect(s.oldestDatestampByUser).toEqual({ a: 7 });
    expect(sourcesToStream(s)).toEqual(["a"]);
    expect(sourcesToStream(s, ["b"])).toEqual(["b"]);
  });

  it("no note without a full batch, and none while the stream runs", () => {
    expect(scoutStreamCapNoteHtml({ state: "paused", batchFull: false })).toBe("");
    expect(scoutStreamCapNoteHtml({ state: "running", batchFull: true })).toBe("");
  });
});
