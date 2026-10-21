import { afterEach, expect, it, vi } from "vitest";
import { analyzeGamePositions, AnalysisCancelled } from "./game-analyzer.js";
import { createEngineProvider } from "./stockfish-provider.js";
import { loadEngineModule, EngineAssetError } from "./engine-assets.js";
import { createEngineAnalysisRun, engineProfile, detectEngineProfile } from "./engine-profile.js";

vi.mock("./engine-assets.js", async importOriginal => ({ ...await importOriginal(),
  loadEngineModule: vi.fn(async () => ({})),
}));
vi.mock("./engine-profile.js", () => ({
  engineProfile: vi.fn(() => ({ net: "lite", workers: 1 })),
  usableEngineProfile: vi.fn(() => ({ net: "lite", workers: 1 })),
  detectEngineProfile: vi.fn(() => new Promise(() => {})),
  createEngineAnalysisRun: vi.fn(),
}));
vi.mock("./stockfish-provider.js", () => ({ ANALYSIS_MAX_NODES: 1500000, createEngineProvider: vi.fn() }));

const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
function setup() {
  vi.useFakeTimers();
  const run = { profile: () => engineProfile(), start: vi.fn(() => engineProfile()), retry: vi.fn(), done: vi.fn() };
  createEngineAnalysisRun.mockReturnValue(run);
  const provider = { open: vi.fn(async () => {}), close: vi.fn(async () => {}),
    snapshot: () => ({ running: false, current_depth: 12, pvs: [{ score_cp: 20, pv_uci: ["e2e4"] }] }) };
  createEngineProvider.mockReturnValue(provider);
  return { run, provider };
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

it("starts analysis at the user's depth while detection remains pending", async () => {
  const f = setup();
  void detectEngineProfile(); // a background probe that never completes
  const result = await analyzeGamePositions({ positions: [fen], depth: 23 });
  expect(result.get(fen)).toMatchObject({ score_cp: 20 });
  expect(loadEngineModule).toHaveBeenLastCalledWith("lite");
  expect(createEngineProvider).toHaveBeenCalledWith(expect.objectContaining({ net: "lite", maxDepth: 23 }));
  expect(detectEngineProfile).toHaveBeenCalledTimes(1);
  expect(f.run.done).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(8000);
});

it.each([false, true])("analysis waits for assets before either startup deadline or the run guard (cancel=%s)", async cancel => {
  const f = setup();
  let resolveModule;
  loadEngineModule.mockImplementationOnce(() => new Promise(resolve => { resolveModule = resolve; }));
  let cancelled = false;
  const pending = analyzeGamePositions({ positions: [fen], depth: 12,
    shouldCancel: () => cancelled }).catch(error => error);
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.run.start).not.toHaveBeenCalled();
  expect(createEngineProvider).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  cancelled = cancel;
  resolveModule({});
  const result = await pending;
  if (cancel) {
    expect(result).toBeInstanceOf(AnalysisCancelled);
    expect(createEngineProvider).not.toHaveBeenCalled();
  } else {
    expect(result.get(fen)).toMatchObject({ score_cp: 20 });
    expect(f.run.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8000); // release the warm pool
  }
  expect(f.run.retry).not.toHaveBeenCalled();
});

it("does not arm a crash guard or retry memory profiles when asset preparation fails", async () => {
  const f = setup();
  const error = new EngineAssetError(new RangeError("compile aborted: out of memory"));
  loadEngineModule.mockRejectedValueOnce(error);
  await expect(analyzeGamePositions({ positions: [fen], depth: 12 })).rejects.toBe(error);
  expect(f.run.start).not.toHaveBeenCalled();
  expect(f.run.retry).not.toHaveBeenCalled();
  expect(createEngineProvider).not.toHaveBeenCalled();
});

it("does not classify an asset error from a provider as a memory failure", async () => {
  const f = setup();
  const error = new EngineAssetError(new RangeError("download aborted"));
  f.provider.open.mockRejectedValueOnce(error);
  await expect(analyzeGamePositions({ positions: [fen], depth: 12 })).rejects.toBe(error);
  expect(f.run.retry).not.toHaveBeenCalled();
  expect(f.provider.close).toHaveBeenCalled();
});
