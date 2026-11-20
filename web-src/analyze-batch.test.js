import { describe, expect, it, vi } from "vitest";
import { createBatchSwitcher } from "./analyze-batch.js";

function harness() {
  const old = { game_id: "g1", pgn: "1. e4 e5" };
  const appState = { analysis: old, analysisMultiPgn: "batch" };
  const summary = { selected_index: 0, selected_game_id: "g1", games: [
    { index: 0, game_id: "g1", status: "existing" }, { index: 1, game_id: "g2", status: "existing" },
  ] };
  const select = { value: "1", disabled: false };
  const host = { setAttribute: vi.fn(), querySelector: () => select, hidden: false, innerHTML: "picker" };
  let seq = 0;
  const invalidate = () => { appState.analysisMultiPgn = null; return ++seq; };
  const deps = {
    appState, invalidateAnalysisSource: invalidate, sourceIsCurrent: value => value === seq,
    recallAnalysis: vi.fn(async () => { appState.analysis = { game_id: "g2", pgn: "1. d4 d5" }; return true; }),
    runAnalysis: vi.fn(async () => {}), isBusy: vi.fn(() => false), setStatus: vi.fn(),
  };
  return { change: createBatchSwitcher(deps), deps, appState, summary, host, select, old, invalidate };
}

describe("completed batch analysis switching", () => {
  it("recalls completed analysis without prepare, engine work, or classify-save", async () => {
    const h = harness();
    await h.change(h.summary, 1, h.host);
    expect(h.deps.recallAnalysis).toHaveBeenCalledWith("g2", h.summary.games[1], expect.objectContaining({ sourceSeq: 1 }));
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
    expect(h.appState.analysisSourcePgn).toBe("1. d4 d5");
    expect(h.appState.analysisMultiPgn).toBe("batch");
    expect(h.summary.selected_index).toBe(1);
    expect(h.select.disabled).toBe(false);
  });

  it("retains the displayed game while the saved report loads", async () => {
    const h = harness();
    let finish;
    h.deps.recallAnalysis.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const switching = h.change(h.summary, 1, h.host);
    expect(h.appState.analysis).toBe(h.old);
    expect(h.select.disabled).toBe(true);
    expect(h.host.setAttribute).toHaveBeenLastCalledWith("aria-busy", "true");
    finish(true);
    await switching;
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
    expect(h.host.setAttribute).toHaveBeenLastCalledWith("aria-busy", "false");
  });

  it("analyzes the original batch only when no usable saved report exists", async () => {
    const h = harness();
    h.deps.recallAnalysis.mockImplementation(async (_id, _game, { onMissing }) => { onMissing(); return false; });
    await h.change(h.summary, 1, h.host);
    expect(h.deps.runAnalysis).toHaveBeenCalledExactlyOnceWith({ mode: "multi", selectIndex: 1, fromBatch: true });
    expect(h.appState.analysisMultiPgn).toBe("batch");
  });

  it("does not recompute on a recall error and restores the selected game", async () => {
    const h = harness();
    h.deps.recallAnalysis.mockResolvedValue(false);
    await h.change(h.summary, 1, h.host);
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
    expect(h.select.value).toBe("0");
    expect(h.appState.analysis).toBe(h.old);
  });

  it("does not start an analysis after another source supersedes a missing report", async () => {
    const h = harness();
    h.deps.recallAnalysis.mockImplementation(async (_id, _game, { onMissing }) => { h.invalidate(); onMissing(); return false; });
    await h.change(h.summary, 1, h.host);
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
    expect(h.appState.analysisMultiPgn).toBeNull();
  });

  it("ignores empty or failed entries and retires a picker whose batch has ended", async () => {
    const h = harness();
    await h.change({ games: [] }, 1, h.host);
    await h.change({ games: [{ index: 1, status: "failed" }] }, 1, h.host);
    expect(h.deps.recallAnalysis).not.toHaveBeenCalled();
    h.appState.analysisMultiPgn = null;
    await h.change(h.summary, 1, h.host);
    expect(h.host.hidden).toBe(true);
    expect(h.host.innerHTML).toBe("");
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
  });

  it("does not replace a report while a whole-game review is still running", async () => {
    const h = harness();
    h.deps.isBusy.mockReturnValue(true);
    await h.change(h.summary, 1, h.host);
    expect(h.deps.recallAnalysis).not.toHaveBeenCalled();
    expect(h.deps.runAnalysis).not.toHaveBeenCalled();
    expect(h.select.value).toBe("0");
    expect(h.appState.analysis).toBe(h.old);
  });
});
