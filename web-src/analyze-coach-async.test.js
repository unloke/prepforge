import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
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

function harness() {
  let view = "analyze";
  let gameOver = null;
  const moduleGate = deferred();
  const render = vi.fn();
  const store = fakeStore();
  const deps = {
    window: globalThis, effectiveStockfishDepth: () => 16, analysisStore: async () => store,
    setEngineBestArrow: vi.fn(), activeViewName: () => view, isBrowserEngineAvailable: () => true,
    isReviewedMove: () => true, analysisSelfSide: () => null,
    _coachReady: moduleGate.promise, preloadCoach: () => moduleGate.promise,
    savedPositionEvalRead: () => null, savedMainlineMove: () => ({ classification: "good" }),
    previousAnalysisMove: () => null, localBoardInfo: () => ({ status: {} }),
    localGameOver: () => gameOver,
    renderCoachProse: render, maiaAnalysisEnabled: () => false,
    COACH_MIN_REUSE_DEPTH: 10,
  };
  const start = source.indexOf("class PositionCoach {");
  const end = source.indexOf("\nconst positionCoach =", start);
  const Coach = new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
  const coach = new Coach();
  coach.fen = "after b - - 0 1";
  coach.ctx = { prevFen: "before w - - 0 1", lastUci: "e2e4", lastSan: "e4", ply: 1 };
  const mod = { buildMoveFeatures: (x) => x, buildCommentary: (f) => ({ prose: `Engine verdict on ${f.fenAfter}` }) };
  const answerAll = (depth) => store.leases.filter((l) => !l.released).forEach((l) => l.answer(read(l.fen, depth)));
  return { coach, store, moduleGate, mod, render, answerAll, terminal: (over) => { gameOver = over; }, leave: () => { view = "build"; coach.cancel(); } };
}
afterEach(() => vi.useRealTimers());

describe("PositionCoach async continuation ownership", () => {
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
