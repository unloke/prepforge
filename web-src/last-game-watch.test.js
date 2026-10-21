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

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// ---- importLatestGame ------------------------------------------------------
function importHarness({ pgn = '[White "me"]\n[Black "them"]\n\n1. e4 e5 *', white = "me", black = "them", id = "g1", source_account = null, loadFails = false } = {}) {
  const input = { value: "" }, button = { dataset: {}, disabled: false };
  const game = { has_game: true, lichess_id: id, white, black, source_account, pgn };
  const order = [], appState = { accountUserId: 'u1', ownerGeneration: 0, lichessUsername: 'me' };
  const api = vi.fn(async () => ({ ...game, pgn }));
  const deps = {
    appState,
    currentOwnerId: () => appState.accountUserId,
    holdNewGameNudge: vi.fn(() => vi.fn()),
    requireSignIn: () => true, lichessAccounts: () => [], startLichessOAuth: vi.fn(), syncFetchMyGameButton: vi.fn(),
    api,
    setStatus: vi.fn(),
    setStatusError: vi.fn(),
    markLichessSeen: vi.fn(async () => { order.push("seen"); }),
    orientAnalysisForSelf: vi.fn((w, b, extra) => { order.push(`orient:${w}/${b}:${extra[0] || ""}`); }),
    loadPgnIntoAnalyze: vi.fn(async () => { order.push("load"); return !loadFails; }),
    runAnalysis: vi.fn(async () => { order.push("run"); }),
    document: { getElementById: id => id === 'pgn-input' ? input : button },
  };
  const actions = new Function(...Object.keys(deps), `let analysisRecallSeq = 0;
    function invalidateAnalysisSource() { return ++analysisRecallSeq; }
    ${body('function latestGameHandoff(')}
    ${body('export async function importLatestGame(').replace('export ', '')}
    ${body('export async function fetchMyLichessGame(').replace('export ', '')}
    return { run: importLatestGame, fetch: fetchMyLichessGame, supersede: invalidateAnalysisSource };`)(...Object.values(deps));
  return { ...actions, input, button, deps, order, game };
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

  it("acknowledges the game only after its PGN handoff succeeds", async () => {
    const h = importHarness({ id: "g-new" });
    await h.run(h.game);
    expect(h.deps.markLichessSeen).toHaveBeenCalledTimes(1);
    expect(h.deps.markLichessSeen).toHaveBeenCalledWith("g-new");
    expect(h.order.indexOf("seen")).toBeGreaterThan(h.order.indexOf("load"));
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
  it('uses the full response metadata when the latest game changes during the fetch', async () => {
    const h = importHarness();
    const newer = { ...h.game, lichess_id: 'g2', white: 'opponent2', black: 'alt', source_account: 'alt', pgn: '[White "opponent2"]\n[Black "alt"]\n\n1. d4 d5 *' };
    h.game.pgn = '';
    h.deps.api.mockResolvedValueOnce(newer);
    expect(await h.run(h.game)).toBe(true);
    expect(h.input.value).toBe(newer.pgn);
    expect(h.deps.orientAnalysisForSelf).toHaveBeenCalledWith('opponent2', 'alt', ['alt']);
    expect(h.deps.markLichessSeen).toHaveBeenCalledExactlyOnceWith('g2');
  });

  it('does not acknowledge or analyze a rejected PGN', async () => {
    const h = importHarness({ loadFails: true });
    expect(await h.run(h.game)).toBe(false);
    expect(h.deps.markLichessSeen).not.toHaveBeenCalled();
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
    expect(h.deps.setStatusError).toHaveBeenCalled();
  });

  it.each(['owner', 'source'])('discards a full response after the %s changes', async change => {
    const h = importHarness(), response = deferred(), full = { ...h.game };
    h.game.pgn = '';
    h.deps.api.mockReturnValueOnce(response.promise);
    const importing = h.run(h.game);
    h.input.value = 'the newer choice';
    if (change === 'owner') h.deps.appState.accountUserId = 'u2';
    else h.supersede();
    response.resolve(full);
    expect(await importing).toBe(false);
    expect(h.input.value).toBe('the newer choice');
    expect(h.deps.orientAnalysisForSelf).not.toHaveBeenCalled();
    expect(h.deps.markLichessSeen).not.toHaveBeenCalled();
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
  });

  it('does not finish a handoff from an earlier login of the same owner', async () => {
    const h = importHarness(), load = deferred();
    h.deps.loadPgnIntoAnalyze.mockReturnValueOnce(load.promise);
    const importing = h.run(h.game);
    h.deps.appState.ownerGeneration++;
    load.resolve(true);
    expect(await importing).toBe(false);
    expect(h.deps.orientAnalysisForSelf).toHaveBeenCalledTimes(1);
    expect(h.deps.markLichessSeen).not.toHaveBeenCalled();
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
  });

  it('re-enables Last game so a second completed game can be loaded', async () => {
    const h = importHarness();
    await h.fetch();
    expect(h.button.disabled).toBe(false);
    await h.fetch();
    expect(h.deps.runAnalysis).toHaveBeenCalledTimes(2);
    expect(h.button.disabled).toBe(false);
  });

  it('an older button request cannot overwrite or re-enable a newer one', async () => {
    const h = importHarness(), first = deferred(), second = deferred();
    h.deps.api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = h.fetch();
    h.deps.appState.ownerGeneration++;
    const newer = h.fetch();
    first.resolve(h.game);
    await older;
    expect(h.button.disabled).toBe(true);
    expect(h.input.value).toBe('');
    second.resolve({ ...h.game, lichess_id: 'g2' });
    await newer;
    expect(h.button.disabled).toBe(false);
    expect(h.deps.markLichessSeen).toHaveBeenCalledExactlyOnceWith('g2');
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
      const card = { key: opts.key, title: opts.title, onClose: opts.onClose, removed: false };
      card.dismiss = vi.fn(() => {
        card.removed = true;
        const close = card.onClose;
        card.onClose = null;
        close?.();
      });
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
    "let analyzeEntry = null;",
    "let acknowledgedGameIds = new Set();",
    "let latestProbe = null;",
    "let newGameNudgeHold = null;",
    "let newGameNudgeVersion = 0;",
    "let watchWasAway = false, foregroundRefreshPending = false;",
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
    body("export function holdNewGameNudge(").replace("export ", ""),
    body("export function dismissNewGameNudge(").replace("export ", ""),
    body("export async function markLichessSeen(").replace("export ", ""),
  ].join("\n");
  const api2 = new Function(...Object.keys(deps), `${snippets}
    return { startLichessGameWatch, resetLichessGameWatch, checkLatestLichessGame, markLichessSeen,
      dismissNewGameNudge, holdNewGameNudge, finishedRecently };`)(...Object.values(deps));
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

  it('a real return inside the duplicate-event window still checks for a new game', async () => {
    const h = watchHarness({ latestSequence: [gamePayload('base'), gamePayload('returned')] });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    h.listeners.get('win:blur')();
    h.listeners.get('win:focus')();
    h.listeners.get('doc:visibilitychange')();
    await h.checkLatestLichessGame();
    expect(h.probeCount).toBe(2);
    expect(h.shown[0].opts.key).toBe('newgame-returned');
  });

  it('refreshes after a return during an older probe without showing its stale game', async () => {
    const h = watchHarness({ latestSequence: [gamePayload('base')] }), old = deferred(), fresh = deferred();
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    h.slots.api.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const probing = h.checkLatestLichessGame();
    h.listeners.get('win:blur')();
    h.listeners.get('win:focus')();
    old.resolve(gamePayload('stale'));
    await probing;
    expect(h.shown).toHaveLength(0);
    const refreshed = h.checkLatestLichessGame();
    fresh.resolve(gamePayload('fresh'));
    await refreshed;
    expect(h.shown.map(entry => entry.opts.key)).toEqual(['newgame-fresh']);
    expect(h.slots.api).toHaveBeenCalledTimes(3);
  });

  it('an old login failure cannot clear a newer probe or its freshness timestamp', async () => {
    const h = watchHarness(), old = deferred(), current = deferred();
    h.appState.ownerGeneration = 0;
    h.slots.api.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    h.startLichessGameWatch();
    const older = h.checkLatestLichessGame();
    h.appState.ownerGeneration++;
    h.resetLichessGameWatch();
    h.startLichessGameWatch();
    const newer = h.checkLatestLichessGame(), freshAt = h.appState.lichessLastProbeAt;
    old.reject(new Error('old request failed'));
    await older;
    expect(h.checkLatestLichessGame()).toBe(newer);
    expect(h.appState.lichessLastProbeAt).toBe(freshAt);
    expect(h.slots.api).toHaveBeenCalledTimes(2);
    current.resolve(gamePayload('current-owner-baseline'));
    await newer;
    expect(h.appState.lichessBaselineId).toBe('current-owner-baseline');
    expect(h.shown).toHaveLength(0);
  });

  it('a queued seen write from an earlier login cannot run as the next owner', async () => {
    const h = watchHarness(), firstPost = deferred(), written = [];
    h.appState.ownerGeneration = 0;
    h.deps.postJson.mockImplementation((_path, data) => {
      written.push([h.slots.owner(), data.lichess_id]);
      return data.lichess_id === 'old-first' ? firstPost.promise : Promise.resolve({ ok: true });
    });
    const first = h.markLichessSeen('old-first'), queued = h.markLichessSeen('old-queued');
    await Promise.resolve();
    h.slots.owner = () => 'u2';
    h.appState.ownerGeneration++;
    h.resetLichessGameWatch();
    const next = h.markLichessSeen('new-owner');
    await Promise.resolve();
    const beforeRelease = [...written];
    firstPost.resolve({ ok: true });
    await Promise.all([first, queued, next]);
    expect(beforeRelease).toEqual([['u1', 'old-first'], ['u2', 'new-owner']]);
    expect(written).toEqual([['u1', 'old-first'], ['u2', 'new-owner']]);
  });

  it('acknowledging an older game preserves the newer visible card', async () => {
    const h = watchHarness({ latestSequence: [gamePayload('base'), gamePayload('fresh')] });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    await h.checkLatestLichessGame();
    await h.markLichessSeen('older');
    expect(h.shown[0].card.removed).toBe(false);
    expect(h.appState.newGameWidgetId).toBe('fresh');
  });

  it.each(['release', 'supersede'])('a pending import keeps the baseline available for recovery on %s', async action => {
    const h = watchHarness({ latestSequence: [gamePayload('base'), gamePayload('fresh')] });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    let valid = true;
    const release = h.holdNewGameNudge(() => valid);
    await h.checkLatestLichessGame();
    expect(h.shown).toHaveLength(0);
    expect(h.appState.lichessBaselineId).toBe('base');
    if (action === 'release') release(); else valid = false;
    await h.checkLatestLichessGame();
    expect(h.shown[0].opts.key).toBe('newgame-fresh');
  });

  it.each(['before', 'during'])('a probe issued %s the import cannot offer an older game after success', async phase => {
    const h = watchHarness({ latestSequence: [gamePayload('base'), gamePayload('truly-newer')] }), old = deferred();
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    h.slots.api.mockReturnValueOnce(old.promise);
    let probing;
    if (phase === 'before') probing = h.checkLatestLichessGame();
    const release = h.holdNewGameNudge(() => true);
    if (phase === 'during') probing = h.checkLatestLichessGame();
    await h.markLichessSeen('loaded');
    release();
    old.resolve(gamePayload('older-than-loaded'));
    await probing;
    expect(h.shown).toHaveLength(0);
    await h.checkLatestLichessGame();
    expect(h.shown[0].opts.key).toBe('newgame-truly-newer');
  });

  it('replaces an older prompt without acknowledging it or keeping two cards', async () => {
    const h = watchHarness({ latestSequence: [gamePayload('base'), gamePayload('one'), gamePayload('two')] });
    h.startLichessGameWatch();
    await h.checkLatestLichessGame();
    await h.checkLatestLichessGame();
    await h.checkLatestLichessGame();
    expect(h.shown.filter(entry => !entry.card.removed).map(entry => entry.opts.key)).toEqual(['newgame-two']);
    expect(h.deps.postJson).not.toHaveBeenCalled();
    expect(h.shown[1].opts.actions[0].closeOnClick).toBe(false);
  });

  it("finishedRecently keeps the tri-state gate", () => {
    const h = watchHarness({ latestSequence: [{ has_game: false }] });
    expect(h.finishedRecently(new Date().toISOString())).toBe(true);
    expect(h.finishedRecently(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString())).toBe(false);
    expect(h.finishedRecently(null)).toBeNull();
    expect(h.finishedRecently("not a date")).toBeNull();
  });
});
