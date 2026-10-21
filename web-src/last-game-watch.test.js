import { expect, it, describe, vi } from "vitest";
import { appSource } from "./test-app-source.js";

// The latest-game path is one import (Analyze's "Last game" and the watcher's
// "You just finished a game!" card) and one watch loop. These read the real
// functions out of the app source so a change to either cannot slip past.
const source = appSource();
function body(marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`not found: ${marker}`);
  return source.slice(start, source.indexOf("\n}\n", start) + 2);
}

// ---- importLatestGame ------------------------------------------------------
function importHarness({ pgn = '[White "me"]\n[Black "them"]\n\n1. e4 e5 *', white = "me", black = "them", id = "g1", source_account = null, loadFails = false } = {}) {
  const input = { value: "" };
  const order = [];
  const api = vi.fn(async () => ({ pgn: `${pgn}` }));
  const deps = {
    appState: {},
    api,
    setStatus: vi.fn(),
    setStatusError: vi.fn(),
    markLichessSeen: vi.fn(async () => { order.push("seen"); }),
    orientAnalysisForSelf: vi.fn((w, b, extra) => { order.push(`orient:${white}/${black}:${extra[0] || ""}`); }),
    loadPgnIntoAnalyze: vi.fn(async () => { order.push("load"); return !loadFails; }),
    runAnalysis: vi.fn(async () => { order.push("run"); }),
    document: { getElementById: () => input },
  };
  const run = new Function(...Object.keys(deps), `${body("export async function importLatestGame(").replace("export ", "")} return importLatestGame;`)(...Object.values(deps));
  return { run, input, deps, order, game: { has_game: true, lichess_id: id, white, black, source_account, pgn } };
}

describe("importLatestGame", () => {
  it("orients for this game BEFORE the move list loads, and again after", async () => {
    const h = importHarness({ white: "them", black: "me" });
    await h.run(h.game);
    const orients = h.order
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.startsWith("orient"));
    expect(orients).toHaveLength(2);
    // The board is flipped before the async Analyze handoff, so the previous
    // game's perspective never shows over this one.
    expect(orients[0].index).toBeLessThan(h.order.indexOf("load"));
    expect(orients[1].index).toBeGreaterThan(h.order.indexOf("load"));
  });

  it("passes the game's source account as an extra Self identity", async () => {
    const h = importHarness({ white: "them", black: "alt_handle", source_account: "alt_handle" });
    await h.run(h.game);
    expect(h.deps.orientAnalysisForSelf).toHaveBeenCalledWith("them", "alt_handle", ["alt_handle"]);
  });

  it("acknowledges the game it loaded, once, before the slow handoff", async () => {
    const h = importHarness({ id: "g-new" });
    await h.run(h.game);
    expect(h.deps.markLichessSeen).toHaveBeenCalledTimes(1);
    expect(h.deps.markLichessSeen).toHaveBeenCalledWith("g-new");
    expect(h.order.indexOf("seen")).toBeLessThan(h.order.indexOf("load"));
  });

  it("fetches the full game when the watcher's light probe carried no PGN", async () => {
    const h = importHarness({ id: "g-light" });
    h.game.pgn = "";
    await h.run(h.game);
    expect(h.deps.api).toHaveBeenCalledWith("/api/lichess/latest");
    expect(h.input.value).toContain("[White");
  });

  it("never acknowledges a game it could not load", async () => {
    const h = importHarness({ id: "g-fail" });
    h.game.pgn = "";
    h.deps.api.mockRejectedValueOnce(Object.assign(new Error("lichess down"), { status: 502 }));
    expect(await h.run(h.game)).toBe(false);
    expect(h.deps.markLichessSeen).not.toHaveBeenCalled();
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
  });
});

// ---- the watcher -----------------------------------------------------------
// A minimal window/document/timer world: the watch loop is promise-driven, so
// the tests drive focus and read what the probe decided.
function watchHarness({ latestSequence = [], accounts = [{ id: "a1", username: "me" }], owner = "u1" } = {}) {
  const listeners = new Map();
  const doc = {
    visibilityState: "visible",
    addEventListener: (type, fn) => listeners.set(`doc:${type}`, fn),
    removeEventListener: (type) => listeners.delete(`doc:${type}`),
  };
  const win = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener: (type, fn) => listeners.set(`win:${type}`, fn),
    removeEventListener: (type) => listeners.delete(`win:${type}`),
  };
  let probe = 0;
  const appState = {
    lichessUsername: "me",
    lichessAccounts: accounts,
    currentView: "analyze",
  };
  const shown = [];
  const seen = [];
  const notices = {
    show: (_message, opts) => {
      const card = { key: opts.key, title: opts.title, removed: false, dismiss: vi.fn(() => { card.removed = true; }) };
      shown.push({ card, opts });
      return card;
    },
  };
  const slots = {
    api: vi.fn(async () => {
      const next = latestSequence[Math.min(probe++, latestSequence.length - 1)] || { has_game: false };
      if (next instanceof Error) throw next;
      return next;
    }),
    owner: () => owner,
  };
  const deps = {
    appState, notices,
    window: win, document: doc,
    api: (...args) => slots.api(...args),
    postJson: vi.fn(async () => ({ ok: true })),
    currentOwnerId: () => slots.owner(),
    lichessAccounts: () => appState.lichessAccounts,
    switchView: vi.fn(),
    setStatus: vi.fn(),
  };
  const snippets = [
    "const LICHESS_RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;",
    "const LICHESS_POLL_ACTIVE_MS = 25 * 1000;",
    "const LICHESS_POLL_IDLE_MS = 3 * 60 * 1000;",
    "const LICHESS_ACTIVE_WINDOW_MS = 3 * 60 * 1000;",
    "const LICHESS_FOCUS_MIN_GAP_MS = 2000;",
    "let newGameNudgeCard = null;",
    "let acknowledgedGameIds = new Set();",
    "let latestProbe = null;",
    "let seenWrite = Promise.resolve();",
    body("export function startLichessGameWatch(").replace("export ", ""),
    body("function stopLichessGameWatch("),
    body("function resetLichessGameWatch("),
    body("function watchIdentity("),
    body("export function noteLichessActivity(").replace("export ", ""),
    body("function scheduleLichessPoll("),
    body("export function finishedRecently(").replace("export ", ""),
    body("function checkLatestLichessGame("),
    body("async function probeLatestLichessGame("),
    body("function showNewGameWidget("),
    body("export function dismissNewGameNudge(").replace("export ", ""),
    body("export async function markLichessSeen(").replace("export ", ""),
  ].join("\n");
  const api2 = new Function(...Object.keys(deps), `${snippets}
    analyzeEntry = null;
    return { startLichessGameWatch, resetLichessGameWatch, checkLatestLichessGame, markLichessSeen,
      dismissNewGameNudge, finishedRecently };`)(...Object.values(deps));
  return { ...api2, appState, shown, deps, slots, listeners, seen, get probeCount() { return probe; } };
}

const gamePayload = (id, { white = "me", black = "them", minutesAgo = 1, isNew = true } = {}) => ({
  has_game: true, lichess_id: id, white, black, result: "1-0", is_new: isNew,
  source_account: white, finished_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

describe("latest-game watch", () => {
  it("the first sighting is the silent baseline: an old game is never 'just finished'", async () => {
    const h = watchHarness({ latestSequence: [gamePayload("old", { minutesAgo: 300 })] });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    expect(h.shown).toHaveLength(0);
    expect(h.appState.lichessBaselineId).toBe("old");
  });

  it("a game finished while away is offered once, and a repeat probe stays quiet", async () => {
    const h = watchHarness({
      latestSequence: [gamePayload("base"), gamePayload("fresh", { minutesAgo: 0.2 }), gamePayload("fresh", { minutesAgo: 0.2 })],
    });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    await h.checkLatestLichessGame();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].opts.title).toBe("You just finished a game!");
    await h.checkLatestLichessGame();
    expect(h.shown).toHaveLength(1);
  });

  it("a burst of focus/visibility signals shares one probe", async () => {
    const h = watchHarness({ latestSequence: [gamePayload("base")] });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    h.appState.lichessLastProbeAt = 0;
    const before = h.probeCount;
    h.listeners.get("win:focus")();
    h.listeners.get("doc:visibilitychange")();
    h.listeners.get("win:focus")();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.probeCount - before).toBe(1);
  });

  it("an immediate second burst is throttled; a later one probes again", async () => {
    const h = watchHarness({ latestSequence: [gamePayload("base")] });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    h.appState.lichessLastProbeAt = 0;
    const before = h.probeCount;
    h.listeners.get("win:focus")();
    h.listeners.get("win:focus")();
    expect(h.probeCount - before).toBe(1);
    // The in-flight probe settles, then the throttle window is pretended past.
    await h.checkLatestLichessGame();
    h.appState.lichessLastProbeAt = 0;
    h.listeners.get("win:focus")();
    expect(h.probeCount - before).toBe(2);
  });

  it("a probe that was in flight when the game was acknowledged cannot re-show it", async () => {
    // The probe answers with the SAME game the user just loaded through Last game.
    const h = watchHarness({
      latestSequence: [gamePayload("base"), gamePayload("handled", { minutesAgo: 0.2 })],
    });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    await h.markLichessSeen("handled");
    await h.checkLatestLichessGame();
    expect(h.shown).toHaveLength(0);
  });

  it("dismissing the card is not an acknowledgement of a different game", async () => {
    const h = watchHarness({
      latestSequence: [gamePayload("base"), gamePayload("shown", { minutesAgo: 0.2 })],
    });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    await h.checkLatestLichessGame();
    expect(h.shown).toHaveLength(1);
    h.dismissNewGameNudge();
    expect(h.shown[0].card.dismiss).toHaveBeenCalled();
    expect(h.deps.postJson).not.toHaveBeenCalled();
  });

  it("a newer game still gets its own card after the previous one was dismissed", async () => {
    const h = watchHarness({
      latestSequence: [gamePayload("base"), gamePayload("one", { minutesAgo: 0.2 }), gamePayload("two", { minutesAgo: 0.1 })],
    });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    await h.checkLatestLichessGame();
    h.dismissNewGameNudge();
    await h.checkLatestLichessGame();
    expect(h.shown).toHaveLength(2);
    expect(h.shown[1].opts.key).toBe("newgame-two");
  });

  it("the seen writes stay ordered so the newest game is the server's last-seen", async () => {
    const h = watchHarness({ latestSequence: [gamePayload("base")] });
    h.startLichessGameWatch();
    const order = [];
    h.deps.postJson.mockImplementation(async (_path, body) => { order.push(body.lichess_id); return { ok: true }; });
    await Promise.all([h.markLichessSeen("older"), h.markLichessSeen("newer")]);
    expect(order).toEqual(["older", "newer"]);
  });

  it("a probe issued before an account switch is discarded", async () => {
    let owner = "u1";
    const h = watchHarness({ latestSequence: [gamePayload("base"), gamePayload("other", { minutesAgo: 0.2 })], owner: "u1" });
    h.slots.owner = () => owner;
    const original = h.slots.api;
    h.slots.api = vi.fn(async () => {
      const payload = await original();
      owner = "u2"; // the account changed while the request was out
      return payload;
    });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    await h.checkLatestLichessGame();
    expect(h.shown).toHaveLength(0);
  });

  it("switching accounts drops the baseline and the card", async () => {
    const h = watchHarness({ latestSequence: [gamePayload("base"), gamePayload("mine", { minutesAgo: 0.2 })] });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    await h.checkLatestLichessGame();
    expect(h.shown).toHaveLength(1);
    h.resetLichessGameWatch();
    expect(h.appState.lichessBaselineId).toBeNull();
    expect(h.shown[0].card.dismiss).toHaveBeenCalled();
  });

  it("restarting the watch for the same identity keeps its baseline", async () => {
    const h = watchHarness({ latestSequence: [gamePayload("base"), gamePayload("later", { minutesAgo: 0.2 })] });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    // A settings refresh re-reads the same links and restarts the watch.
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].opts.key).toBe("newgame-later");
  });

  it("a failed probe clears the focus throttle so the next return retries", async () => {
    const h = watchHarness({ latestSequence: [gamePayload("base"), new Error("502"), gamePayload("fresh", { minutesAgo: 0.2 })] });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    h.appState.lichessLastProbeAt = Date.now();
    await h.checkLatestLichessGame();
    expect(h.appState.lichessLastProbeAt).toBe(0);
    h.listeners.get("win:focus")();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.shown).toHaveLength(1);
  });

  it("finishedRecently keeps the tri-state gate", () => {
    const h = watchHarness({ latestSequence: [{ has_game: false }] });
    expect(h.finishedRecently(new Date().toISOString())).toBe(true);
    expect(h.finishedRecently(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString())).toBe(false);
    expect(h.finishedRecently(null)).toBeNull();
    expect(h.finishedRecently("not a date")).toBeNull();
  });
});
