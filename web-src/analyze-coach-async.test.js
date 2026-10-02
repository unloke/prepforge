import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function harness() {
  let view = "analyze";
  const moduleGate = deferred();
  const engineGate = deferred();
  const render = vi.fn();
  const engine = { open: vi.fn(() => engineGate.promise), close: vi.fn(async () => {}), snapshot: () => ({ fen: "before", current_depth: 14, running: false, pvs: [{ score_cp: 20, pv_uci: ["e2e4"] }] }) };
  const deps = {
    window: globalThis, effectiveStockfishDepth: () => 16, createSharedEvaluationProvider: () => engine,
    setEngineBestArrow: vi.fn(), activeViewName: () => view, isBrowserEngineAvailable: () => true,
    isReviewedMove: () => true, analysisSelfSide: () => null,
    _coachReady: moduleGate.promise, preloadCoach: () => moduleGate.promise,
    savedPositionEvalRead: () => null, savedMainlineMove: () => ({ classification: "good" }),
    previousAnalysisMove: () => null, localBoardInfo: () => ({ status: { is_stalemate: true } }),
    renderCoachProse: render, maiaAnalysisEnabled: () => false, sleep: async () => {},
    COACH_MIN_REUSE_DEPTH: 10,
  };
  const start = source.indexOf("class PositionCoach {");
  const end = source.indexOf("\nconst positionCoach =", start);
  const Coach = new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
  const coach = new Coach();
  coach.fen = "after b - - 0 1";
  coach.ctx = { prevFen: "before", lastUci: "e2e4", lastSan: "e4", ply: 1 };
  const mod = { buildMoveFeatures: (x) => x, buildCommentary: () => ({ prose: "Engine verdict" }) };
  return { coach, engine, engineGate, moduleGate, mod, render, leave: () => { view = "build"; coach.cancel(); } };
}
afterEach(() => vi.useRealTimers());

describe("PositionCoach async continuation ownership", () => {
  it("does not open a worker after review was disabled while its module loaded", async () => {
    const h = harness();
    const pending = h.coach._run(h.coach.fen);
    h.coach.enabled = false;
    h.coach.cancel();
    h.moduleGate.resolve(h.mod);
    await pending;
    expect(h.engine.open).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
  });
  it("never paints a departed view or starts an after-search from an obsolete before-search", async () => {
    const h = harness();
    h.moduleGate.resolve(h.mod);
    const pending = h.coach._run(h.coach.fen);
    await vi.waitFor(() => expect(h.engine.open).toHaveBeenCalledOnce());
    h.leave();
    h.engineGate.resolve();
    await pending;
    expect(h.render).not.toHaveBeenCalled();
    expect(h.engine.open).toHaveBeenCalledOnce();
  });
  it("produces commentary after a delayed startup instead of expiring on startup time", async () => {
    const h = harness();
    h.moduleGate.resolve(h.mod);
    const pending = h.coach._run(h.coach.fen);
    await vi.waitFor(() => expect(h.engine.open).toHaveBeenCalledOnce());
    h.engineGate.resolve();
    await pending;
    expect(h.render).toHaveBeenCalledWith({ prose: "Engine verdict" });
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
