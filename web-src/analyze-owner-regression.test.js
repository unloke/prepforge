import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
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
  const run = new Function(...Object.keys(deps), `${code}\nreturn retryAnalyzeSave;`)(...Object.values(deps));
  const pending = run();
  owner = "bob";
  const bobCheckpoint = { ownerId: "bob", gameId: "bob-game" };
  deps.appState.analysisUnsavedCheckpoint = bobCheckpoint;
  resolve({ game_id: "alice-game" });
  await pending;
  expect(deps.clearCheckpoint).toHaveBeenCalledWith("alice-game", "alice");
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
  const jobToast = {
    isBusy: () => busy, startJob: vi.fn(() => { busy = true; }),
    updateJob: vi.fn(), lockJob: vi.fn(),
    cancelJob: vi.fn(() => { busy = false; }), failJob: vi.fn(), completeJob: vi.fn(),
  };
  const deps = {
    appState, jobToast, currentOwnerId: () => owner,
    isBrowserEngineAvailable: () => true, requireSignIn: () => true,
    document: { getElementById: (id) => id === "pgn-input" ? { value: "1. e4" } : runButton },
    invalidateAnalysisSource: () => 1, analysisRecallSeq: 1,
    hideAnalysisHandoff: vi.fn(), loadPgnIntoAnalyze: async () => true,
    engineLifecycleMark: vi.fn(), renderImportPicker: vi.fn(), maiaAnalysisEnabled: () => false,
    createSharedEvaluationProvider: vi.fn(),
    engineModule: { analyzeGamePositions: async () => new Map([["fen", { score_cp: 0 }]]) },
    postJson: vi.fn(async (path) => {
      if (path === "/api/analyze/prepare") return { game_id: "alice-game", positions: ["fen"], depth: 12 };
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
  const run = new Function(...Object.keys(deps), `${runCode}\nreturn runAnalysis;`)(...Object.values(deps));
  await run();
  expect(deps.postJson).toHaveBeenCalledWith("/api/analyze/classify-save", expect.any(Object));
  expect(deps.clearCheckpoint).toHaveBeenCalledWith("alice-game", "alice");
  expect(appState.analysis).toBe(bobAnalysis);
  expect(jobToast.failJob).not.toHaveBeenCalled();
  expect(busy).toBe(false);
  expect(runButton.disabled).toBe(false);
});
