import { afterEach, describe, expect, it, vi } from "vitest";
const source = appSource();
import * as phaseCoach from "./coach/phase-coach.js";
import { appSource } from "./test-app-source.js";
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

// A fake position store: each acquire returns a lease whose until() resolves when the
// test answers it (or null once released), mirroring position-analysis-store.js.
function fakeStore() {
  const leases = [];
  return {
    leases,
    acquire: vi.fn((fen, opts) => {
      const gate = deferred();
      const lease = {
        fen, opts, released: false,
        answer: (snap) => gate.resolve(snap),
        until: () => gate.promise,
        snapshot: () => null,
        release: vi.fn(() => { lease.released = true; gate.resolve(null); }),
      };
      leases.push(lease);
      return lease;
    }),
    maiaRead: vi.fn(),
  };
}
const read = (fen, depth = 16) => ({ fen, current_depth: depth, running: false, pvs: [{ score_cp: 20, pv_uci: ["e2e4"], pv_san: ["e4"] }] });

function harness({ reviewed = true } = {}) {
  let view = "analyze";
  let gameOver = null;
  const moduleGate = deferred();
  const render = vi.fn();
  const store = fakeStore();
  const deps = {
    window: globalThis, effectiveStockfishDepth: () => 16, analysisStore: async () => store,
    setEngineBestArrow: vi.fn(), setAnalysisBetterArrow: vi.fn(), savedBetterMove: () => null,
    offerLiveBetterArrow: vi.fn(), activeViewName: () => view, isBrowserEngineAvailable: () => true,
    isReviewedMove: () => reviewed, analysisSelfSide: () => (reviewed ? null : "black"),
    _coachReady: moduleGate.promise, preloadCoach: () => moduleGate.promise,
    savedPositionEvalRead: () => null, savedMainlineMove: () => ({ classification: "good" }),
    previousAnalysisMove: () => null, localBoardInfo: () => ({ status: {} }),
    localGameOver: () => gameOver,
    renderCoachProse: render, maiaAnalysisEnabled: () => false,
    COACH_MIN_REUSE_DEPTH: 10,
    COACH_RAPID_STEP_MS: 120, COACH_RAPID_SETTLE_MS: 160,
  };
  const start = source.indexOf("class PositionCoach {");
  const end = source.indexOf("\n// Created by createAnalyzeSession", start);
  const Coach = new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
  const coach = new Coach();
  coach.fen = "after b - - 0 1";
  coach.ctx = { prevFen: "before w - - 0 1", lastUci: "e2e4", lastSan: "e4", ply: 1 };
  const mod = {
    buildMoveFeatures: (x) => x,
    buildCommentary: (f, { selfSide }) =>
      ({ prose: f.opponentRead ? `Read for ${selfSide} on ${f.fenAfter}` : `Engine verdict on ${f.fenAfter}` }),
  };
  const answerAll = (depth) => store.leases.filter((l) => !l.released).forEach((l) => l.answer(read(l.fen, depth)));
  return { coach, store, moduleGate, mod, render, answerAll, terminal: (over) => { gameOver = over; }, leave: () => { view = "build"; coach.cancel(); } };
}
afterEach(() => vi.useRealTimers());

describe("PositionCoach async continuation ownership", () => {
  it("does not restore an old Maia tip when its lazy module resolves after navigation", async () => {
    const gate = deferred();
    const paint = vi.fn();
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const appState = { explainContext: { prevFen: fen, lastUci: "e2e4" } };
    const start = source.indexOf("function paintMaiaCoachFromRead(");
    const end = source.indexOf("\nasync function maiaPhaseCoach", start);
    const run = new Function("loadPhaseCoach", "effectiveMaiaRating", "paintMaiaCoachLine", "appState",
      `${source.slice(start, end)}; return paintMaiaCoachFromRead;`)(() => gate.promise, () => 1500, paint, appState);
    const read = { predictions: [{ move_uci: "e2e4", probability: 0.6 }] };
    run(fen, read, { playedUci: "e2e4" });
    // A sibling variation has the same before-FEN but a different played move.
    appState.explainContext = { prevFen: fen, lastUci: "d2d4" };
    gate.resolve(phaseCoach);
    await gate.promise;
    await Promise.resolve();
    expect(paint).not.toHaveBeenCalled();
    run(fen, read, { playedUci: "d2d4" });
    await Promise.resolve();
    expect(paint).toHaveBeenCalledOnce();
  });
  it("produces commentary for a terminal draw without waiting on a nonexistent after PV", async () => {
    const h = harness();
    h.terminal({ kind: "draw", winner: null });
    h.moduleGate.resolve(h.mod);
    const pending = h.coach._run(h.coach.fen);
    await vi.waitFor(() => expect(h.store.acquire).toHaveBeenCalled());
    h.answerAll();
    await pending;
    expect(h.store.acquire).toHaveBeenCalledTimes(1);
    expect(h.render).toHaveBeenCalledOnce();
  });

  it("does not acquire a search after review was disabled while its module loaded", async () => {
    const h = harness();
    const pending = h.coach._run(h.coach.fen);
    h.coach.enabled = false;
    h.coach.cancel();
    h.moduleGate.resolve(h.mod);
    await pending;
    expect(h.store.acquire).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
  });

  it("reads the before and after positions at once, at the Settings depth with two lines", async () => {
    const h = harness();
    h.moduleGate.resolve(h.mod);
    const pending = h.coach._run(h.coach.fen);
    await vi.waitFor(() => expect(h.store.acquire).toHaveBeenCalledTimes(2));
    expect(h.store.leases.map((l) => [l.fen, l.opts])).toEqual([
      ["before w - - 0 1", { depth: 16, multipv: 2 }],
      ["after b - - 0 1", { depth: 16, multipv: 2 }],
    ]);
    h.answerAll();
    await pending;
    expect(h.render).toHaveBeenCalledWith({ prose: "Engine verdict on after b - - 0 1" });
    expect(h.store.leases.every((l) => l.release.mock.calls.length === 1)).toBe(true);
  });

  it("reads the opponent's move for the user instead of leaving it blank", async () => {
    const h = harness({ reviewed: false });
    h.moduleGate.resolve(h.mod);
    const pending = h.coach._run(h.coach.fen);
    await vi.waitFor(() => expect(h.store.acquire).toHaveBeenCalledTimes(2));
    h.answerAll();
    await pending;
    expect(h.render).toHaveBeenCalledWith({ prose: "Read for black on after b - - 0 1" });
  });

  it("never paints a departed view and releases its leases", async () => {
    const h = harness();
    h.moduleGate.resolve(h.mod);
    const pending = h.coach._run(h.coach.fen);
    await vi.waitFor(() => expect(h.store.acquire).toHaveBeenCalledTimes(2));
    h.leave();
    expect(h.store.leases.every((l) => l.released)).toBe(true);
    h.answerAll();
    await pending;
    expect(h.render).not.toHaveBeenCalled();
  });

  it("still produces commentary when the engine answers long after the old 5 s deadline", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.moduleGate.resolve(h.mod);
    const pending = h.coach._run(h.coach.fen);
    await vi.waitFor(() => expect(h.store.acquire).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(30000);
    h.answerAll();
    await pending;
    expect(h.render).toHaveBeenCalledOnce();
  });

  it("retries once on a fresh lane when the engine fails, then paints", async () => {
    const h = harness();
    h.moduleGate.resolve(h.mod);
    const pending = h.coach._run(h.coach.fen);
    await vi.waitFor(() => expect(h.store.acquire).toHaveBeenCalledTimes(2));
    h.store.leases[0].answer({ fen: "before w - - 0 1", error: "worker died", pvs: [] });
    await vi.waitFor(() => expect(h.store.acquire).toHaveBeenCalledTimes(3));
    h.answerAll();
    await pending;
    expect(h.render).toHaveBeenCalledOnce();
  });

  it("a superseded move's late answer never paints over the move the user stopped on", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.moduleGate.resolve(h.mod);
    const first = h.coach._run(h.coach.fen);
    await vi.waitFor(() => expect(h.store.acquire).toHaveBeenCalledTimes(2));
    // The user steps on: the first move's leases are released mid-search.
    h.coach.update("final w - - 0 2", { prevFen: "after b - - 0 1", lastUci: "e7e5", lastSan: "e5", ply: 2 });
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(h.store.acquire).toHaveBeenCalledTimes(4));
    h.answerAll();
    await first;
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledOnce());
    expect(h.render).toHaveBeenCalledWith({ prose: "Engine verdict on final w - - 0 2" });
  });

  it("invalidates immediately on navigation, including the debounce interval", () => {
    vi.useFakeTimers();
    const h = harness();
    const token = h.coach.token;
    h.coach.update("new b - - 0 1", h.coach.ctx);
    expect(h.coach.token).toBeGreaterThan(token);
    h.coach.update(null, {});
    expect(vi.getTimerCount()).toBe(0);
  });
});

 it("does not restore a phase chip after returning to the root or leaving Analyze", async () => {
  const gate = deferred();
  const paint = vi.fn();
  const ctx = { fen: "after", prevFen: "before", lastUci: "e2e4" };
  const appState = { explainContext: ctx };
  let view = "analyze";
  const start = source.indexOf("function paintPhaseFromFen(");
  const end = source.indexOf("\nfunction paintMaiaCoachFromRead", start);
  const run = new Function("loadPhaseCoach", "paintPhaseChip", "appState", "activeViewName",
    `${source.slice(start, end)}; return paintPhaseFromFen;`)(() => gate.promise, paint, appState, () => view);
  run("before");
  appState.explainContext = { fen: "root" };
  gate.resolve({ buildPhaseCoach: () => ({ phase: "middlegame", title: "Middlegame" }) });
  await gate.promise;
  await Promise.resolve();
  expect(paint).not.toHaveBeenCalled();
  appState.explainContext = ctx;
  run("before");
  view = "build";
  await Promise.resolve();
  expect(paint).not.toHaveBeenCalled();
 });

 it("uses cached before/after reads without the navigation debounce", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.moduleGate.resolve(h.mod);
  h.coach._ensureEngine();
  h.coach._remember(h.coach.ctx.prevFen, read(h.coach.ctx.prevFen), 0);
  h.coach._remember(h.coach.fen, read(h.coach.fen), 0);
  expect(h.coach.update(h.coach.fen, h.coach.ctx)).toBe(true);
  await vi.waitFor(() => expect(h.render).toHaveBeenCalledOnce());
  expect(vi.getTimerCount()).toBe(0);
  expect(h.store.acquire).not.toHaveBeenCalled();
 });

 it("holds the cached read back while steps arrive faster than the coach reads", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const h = harness();
  h.moduleGate.resolve(h.mod);
  h.coach._ensureEngine();
  h.coach._remember(h.coach.ctx.prevFen, read(h.coach.ctx.prevFen), 0);
  h.coach._remember(h.coach.fen, read(h.coach.fen), 0);
  expect(h.coach.update(h.coach.fen, h.coach.ctx)).toBe(true);
  await vi.advanceTimersByTimeAsync(0); // waitFor would advance the faked clock past the window
  expect(h.render).toHaveBeenCalledOnce();
  // A held key: the next step 33ms later keeps the instant line instead.
  vi.advanceTimersByTime(33);
  expect(h.coach.update(h.coach.fen, h.coach.ctx)).toBe(false);
  expect(h.render).toHaveBeenCalledOnce();
  // Once the stepping pauses, the full read lands without touching the engine.
  await vi.advanceTimersByTimeAsync(160);
  await vi.waitFor(() => expect(h.render).toHaveBeenCalledTimes(2));
  expect(h.store.acquire).not.toHaveBeenCalled();
 });

 it("only shows instant prose when a verdict needs computation", () => {
  const appState = {};
  const instant = vi.fn();
  const phase = vi.fn();
  const maia = vi.fn();
  const positionCoach = { update: vi.fn(() => true) };
  const start = source.indexOf("function refreshAnalysisExplain(");
  const end = source.indexOf("\n// Instant, engine-free", start);
  const run = new Function("appState", "positionCoach", "renderInstantCoach", "paintPhaseFromFen", "paintMaiaCoachLine", "updateBookline",
    `${source.slice(start, end)}; return refreshAnalysisExplain;`)(appState, positionCoach, instant, phase, maia, async () => {});
  run({ fen: "after", prevFen: "before" });
  expect(instant).not.toHaveBeenCalled();
  expect(phase).toHaveBeenCalledWith("before");
  positionCoach.update.mockReturnValue(false);
  run({ fen: "uncached" });
  expect(instant).toHaveBeenCalledOnce();
 });
