import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";

const source = appSource();

it("the live chart enters Maia loading while warmup is still pending", async () => {
  let resolve;
  const maiaReady = new Promise((done) => { resolve = done; });
  const live = { phase: vi.fn() };
  const start = source.indexOf('    engineLifecycleMark("analyze-stockfish-done"');
  const end = source.indexOf("    // Browser Maia pass", start);
  const run = new Function("live", "maiaReady", "wantsMaia", "overlapMaia", "engineLifecycleMark", "tAnalyze",
    `return (async () => { ${source.slice(start, end)} })();`);
  const pending = run(live, maiaReady, true, true, vi.fn(), 0);
  expect(live.phase).toHaveBeenCalledWith("maia-load");
  resolve();
  await pending;
});

// A phone runs Maia's init only once the Stockfish pass has closed its workers:
// both at once is what the OS killed the tab for after a Detect.
it("a phone starts Maia only after the Stockfish pass", async () => {
  expect(source).toMatch(/const overlapMaia = wantsMaia && !isHandheld\(/);
  expect(source).toMatch(/let maiaReady = overlapMaia \? getSharedMaia3Provider\(\)\.warmup\(\) : null;/);
  expect(source).toMatch(/let assessorReady = overlapMaia \? startAssessor\(\) : null;/);
  const start = source.indexOf('    engineLifecycleMark("analyze-stockfish-done"');
  const end = source.indexOf("    // Browser Maia pass", start);
  const warmup = vi.fn(() => Promise.resolve());
  const startAssessor = vi.fn(() => Promise.resolve(null));
  const run = new Function("live", "maiaReady", "assessorReady", "wantsMaia", "overlapMaia", "engineLifecycleMark", "tAnalyze",
    "getSharedMaia3Provider", "startAssessor",
    `return (async () => { ${source.slice(start, end)} })();`);
  await run({ phase: vi.fn() }, null, null, true, false, vi.fn(), 0, () => ({ warmup }), startAssessor);
  expect(warmup).toHaveBeenCalledTimes(1);
  expect(startAssessor).toHaveBeenCalledTimes(1);
});
function attachFinish(deps) {
  const start = source.indexOf("async function finishAnalyzeCheckpoint(");
  const finish = source.slice(start, source.indexOf("\n}\n", start) + 2);
  const helpers = { ...deps, markCheckpointSaved: vi.fn(), refreshAnalyzeRecovery: vi.fn() };
  deps.finishAnalyzeCheckpoint = new Function(...Object.keys(helpers), `return (${finish});`)(...Object.values(helpers));
}
const code = source.slice(source.indexOf("async function retryAnalyzeSave()"), source.indexOf("\nfunction hideAnalysisHandoff("));

it("Retry save cannot replay a previous owner's in-memory checkpoint", async () => {
  const deps = {
    appState: { analysisUnsavedCheckpoint: { ownerId: "alice", gameId: "private-game" } },
    currentOwnerId: () => "bob", loadCheckpoint: () => null,
    hideAnalysisRetrySave: vi.fn(), invalidateAnalysisSource: () => 0,
    document: { getElementById: () => null }, evalMapFrom: () => new Map(),
    postJson: vi.fn(async () => ({})), clearCheckpoint: vi.fn(),
    refreshAnalysisHistoryIfOpen: vi.fn(), analysisRecallSeq: 1,
    isAuthError: () => false, showAnalysisRetrySave: vi.fn(),
  };
  attachFinish(deps);
  const run = new Function(...Object.keys(deps), `${code}\nreturn retryAnalyzeSave;`)(...Object.values(deps));
  await run();
  expect(deps.postJson).not.toHaveBeenCalled();
});

it("a save response after switching accounts cannot paint or clear the new owner's work", async () => {
  let owner = "alice";
  let resolve;
  const response = new Promise((done) => { resolve = done; });
  const checkpoint = { ownerId: "alice", gameId: "alice-game", positions: [] };
  const deps = {
    appState: { analysisUnsavedCheckpoint: checkpoint }, currentOwnerId: () => owner,
    loadCheckpoint: () => null, hideAnalysisRetrySave: vi.fn(), invalidateAnalysisSource: () => 1,
    document: { getElementById: () => null }, evalMapFrom: () => new Map(),
    postJson: vi.fn(() => response), clearCheckpoint: vi.fn(),
    refreshAnalysisHistoryIfOpen: vi.fn(), analysisRecallSeq: 1,
    isAuthError: () => false, showAnalysisRetrySave: vi.fn(),
  };
  attachFinish(deps);
  const run = new Function(...Object.keys(deps), `${code}\nreturn retryAnalyzeSave;`)(...Object.values(deps));
  const pending = run();
  owner = "bob";
  const bobCheckpoint = { ownerId: "bob", gameId: "bob-game" };
  deps.appState.analysisUnsavedCheckpoint = bobCheckpoint;
  resolve({ game_id: "alice-game" });
  await pending;
  expect(deps.clearCheckpoint).toHaveBeenCalledWith("alice-game", "alice", undefined);
  expect(deps.appState.analysisUnsavedCheckpoint).toBe(bobCheckpoint);
  expect(deps.appState.analysis).toBeUndefined();
  expect(deps.hideAnalysisRetrySave).not.toHaveBeenCalled();
});

it("switching accounts during classify-save releases the analysis job without repainting", async () => {
  let owner = "alice";
  let busy = false;
  const bobAnalysis = { game_id: "bob-game" };
  const runButton = { disabled: false };
  const appState = {};
  const notices = {
    isBusy: () => busy, startJob: vi.fn(() => { busy = true; }),
    updateJob: vi.fn(), lockJob: vi.fn(),
    cancelJob: vi.fn(() => { busy = false; }), failJob: vi.fn(), completeJob: vi.fn(),
  };
  const deps = {
    appState, notices, currentOwnerId: () => owner,
    isBrowserEngineAvailable: () => true, ENGINE_ID: "sf-test", requireSignIn: () => true,
    document: { getElementById: (id) => id === "pgn-input" ? { value: "1. e4" } : runButton },
    invalidateAnalysisSource: () => 1, analysisRecallSeq: 1,
    hideAnalysisHandoff: vi.fn(), loadPgnIntoAnalyze: async () => true,
    engineLifecycleMark: vi.fn(), renderImportPicker: vi.fn(), maiaAnalysisEnabled: () => false,
    analysisStore: async () => ({ analyzeGame: async () => new Map([["fen", { score_cp: 0 }]]) }),
    effectiveStockfishDepth: () => 12,
    createEngineAnalysisRun: () => ({ profile: () => ({ net: "big" }), done: vi.fn() }),
    readyIfCached: async () => {},
    engineIdentity: () => "sf-test",
    ensureAnalyzeView: async () => ({ liveEvalChart: () => () => {} }),
    engineModule: { analyzeGamePositions: async () => new Map([["fen", { score_cp: 0 }]]) },
    postJson: vi.fn(async (path) => {
      if (path === "/api/analyze/prepare") return { game_id: "alice-game", pgn: "1. e4", positions: ["fen"], depth: 12 };
      owner = "bob";
      appState.analysis = bobAnalysis;
      return { moves: [] };
    }),
    saveCheckpoint: vi.fn(() => true), clearCheckpoint: vi.fn(),
    isAuthError: () => false, showAnalysisRetrySave: vi.fn(), setStatus: vi.fn(),
  };
  const start = source.indexOf("async function runAnalysis(");
  const runCode = source.slice(start, source.indexOf("function renderImportPicker(", start))
    .replace('import("./engine/game-analyzer.js")', "Promise.resolve(engineModule)");
  attachFinish(deps);
  const run = new Function(...Object.keys(deps), `${runCode}\nreturn runAnalysis;`)(...Object.values(deps));
  await run();
  expect(deps.postJson).toHaveBeenCalledWith("/api/analyze/classify-save", expect.any(Object));
  expect(deps.clearCheckpoint).toHaveBeenCalledWith("alice-game", "alice", expect.any(String));
  expect(appState.analysis).toBe(bobAnalysis);
  expect(notices.failJob).not.toHaveBeenCalled();
  expect(busy).toBe(false);
  expect(runButton.disabled).toBe(false);
});
