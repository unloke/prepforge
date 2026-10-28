import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { createEngineProfileManager, CRASH_KEY } from "./engine/engine-profile.js";
import { createPositionAnalysisStore } from "./engine/position-analysis-store.js";
import { analyzeGamePositions } from "./engine/game-analyzer.js";

const source = appSource();
const start = source.indexOf("async function runAnalysis(");
const code = source.slice(start, source.indexOf("function renderImportPicker(", start));
const positions = [
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
];

function fixture({ fail = (_net, fen, workers) => workers === 2 && fen === positions[1], cancel = false, save } = {}) {
  const data = new Map();
  const manager = createEngineProfileManager({ assetState: () => ({ phase: "ready" }), beginSession: () => () => {},
    // A real desktop reports both signals; the no-memory-signal (phone-safe) case
    // has its own test in engine-profile.test.js.
    device: () => ({ hardwareConcurrency: 8, deviceMemory: 8 }),
    subscribeAsset: () => () => {}, storage: () => ({ getItem: k => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }) });
  manager.setEngineProfile({ net: "big", workers: 2 });
  const searches = [];
  const createProvider = ({ net }) => {
    let snapshot;
    const read = async ({ fen }) => {
      searches.push([net, fen]);
      if (fail(net, fen, manager.engineProfile().workers)) throw new Error("Aborted(OOM)");
      snapshot = { running: false, fen, current_depth: 12,
        pvs: [{ score_cp: 25, mate_in: null, pv_uci: ["e2e4"] }] };
    };
    return { open: read, update: read, snapshot: () => snapshot, close: async () => {} };
  };
  const store = createPositionAnalysisStore({ createProvider,
    analyzeFn: options => analyzeGamePositions({ ...options, concurrency: 1, createProvider }) });
  manager.subscribeEngineProfile(() => store.clear());
  const engineIdentity = (net = manager.engineProfile().net) => `sf-${net}`;
  const button = { disabled: false };
  const deps = {
    isBrowserEngineAvailable: () => true, requireSignIn: () => true,
    document: { getElementById: id => id === "pgn-input" ? { value: "1. e4" } : button },
    notices: { isBusy: () => false, startJob: vi.fn(job => { if (cancel) job.onCancel(); }),
      updateJob: vi.fn(), lockJob: vi.fn(), completeJob: vi.fn(), cancelJob: vi.fn(), failJob: vi.fn() },
    invalidateAnalysisSource: () => 1, analysisRecallSeq: 1, currentOwnerId: () => "owner", appState: {},
    hideAnalysisHandoff: vi.fn(), loadPgnIntoAnalyze: async () => true, engineLifecycleMark: vi.fn(),
    postJson: vi.fn(async path => path === "/api/analyze/prepare"
      ? { game_id: "game", pgn: "1. e4", positions, depth: 12 } : (save ? save() : { moves: [] })),
    renderImportPicker: vi.fn(), maiaAnalysisEnabled: () => false,
    analysisStore: async () => store, ensureAnalyzeView: async () => ({ liveEvalChart: () => vi.fn() }),
    createEngineAnalysisRun: manager.createEngineAnalysisRun, readyIfCached: manager.readyIfCached,
    engineIdentity,
    saveCheckpoint: vi.fn(async () => true), finishAnalyzeCheckpoint: vi.fn(async () => {}),
    refreshAnalysisHistoryIfOpen: vi.fn(), resetAnalysisVariations: vi.fn(), showAnalysisPly: vi.fn(),
    rebuildAnalysisVariations: vi.fn(async () => true),
    selectedNodePath: () => "root", ANALYSIS_ROOT_PATH: "root", selectAnalysisNodePath: vi.fn(async () => true),
    renderAnalysis: vi.fn(), activeViewName: () => "analyze", revealAnalysisResults: vi.fn(), updateAnalysisHandoff: vi.fn(),
    isAuthError: () => false, setStatusError: vi.fn(), showAnalysisRetrySave: vi.fn(),
    setCoachProse: vi.fn(),
  };
  const run = new Function(...Object.keys(deps), `${code}\nreturn runAnalysis;`)(...Object.values(deps));
  return { run, deps, manager, data, searches, button };
}

it("retries a whole-game engine failure using finished positions on the same net", async () => {
  const f = fixture();
  await f.run();
  expect(f.searches).toEqual([["big", positions[0]], ["big", positions[1]], ["big", positions[1]]]);
  expect(f.deps.saveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ engine: "sf-big", evals: expect.any(Array) }));
  expect(f.deps.postJson).toHaveBeenCalledWith("/api/analyze/classify-save", expect.objectContaining({ engine: "sf-big" }));
  expect(f.deps.notices.completeJob).toHaveBeenCalled();
  expect(f.deps.notices.failJob).not.toHaveBeenCalled();
  expect(f.data.has(CRASH_KEY)).toBe(false);
  expect(f.button.disabled).toBe(false);
});

it("keeps the whole-analysis guard after the engine pass until save/render ends", async () => {
  let resolveSave;
  const save = new Promise(resolve => { resolveSave = resolve; });
  const f = fixture({ fail: () => false, save: () => save });
  const running = f.run();
  // A deferred save gives an observable boundary after all engine work completed.
  await vi.waitFor(() => expect(f.deps.saveCheckpoint).toHaveBeenCalledTimes(1));
  expect(JSON.parse(f.data.get(CRASH_KEY))).toMatchObject({ net: "big", workers: 2 });
  resolveSave({ moves: [] });
  await running;
  expect(f.data.has(CRASH_KEY)).toBe(false);
});

it.each([false, true])("ends the analysis guard on a second failure or clean cancel (cancel=%s)", async cancel => {
  const f = fixture({ fail: () => true, cancel });
  await f.run();
  expect(f.searches).toHaveLength(cancel ? 0 : 2);
  expect(cancel ? f.deps.notices.cancelJob : f.deps.notices.failJob).toHaveBeenCalled();
  expect(f.deps.saveCheckpoint).not.toHaveBeenCalled();
  expect(f.data.has(CRASH_KEY)).toBe(false);
  expect(f.button.disabled).toBe(false);
});
