import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvaluationSource } from "./evaluation-source.js";

let source;
let workers;
beforeEach(() => {
  vi.useFakeTimers();
  workers = [];
  source = createEvaluationSource({ createProvider: (options) => {
    let snap;
    const worker = { options, close: vi.fn(async () => {}),
      open: vi.fn(async ({ fen, multipv }) => { snap = { fen, multipv, pvs: [], current_depth: 0, running: true }; }),
      snapshot: () => snap,
      finish: (depth = 16) => { snap = { ...snap, current_depth: depth, running: false,
        pvs: Array.from({ length: snap.multipv }, () => ({ score_cp: 25, mate_in: null, pv_uci: ["e2e4"] })) }; },
    };
    workers.push(worker);
    return worker;
  } });
});
afterEach(() => { source.clear(); vi.useRealTimers(); });

describe("shared evaluation ownership", () => {
  it("Coach, Analyze and Engine join one search and closing Engine does not stop Coach", async () => {
    const coach = source.createHandle({ maxDepth: 16 });
    const engine = source.createHandle({ maxDepth: 16 });
    const analyze = source.createHandle({ maxDepth: 16 });
    await Promise.all([coach.open({ fen: "A", multipv: 2 }), engine.open({ fen: "A" }), analyze.open({ fen: "A" })]);
    expect(workers).toHaveLength(1);
    await engine.close();
    expect(workers[0].close).not.toHaveBeenCalled();
    workers[0].finish();
    expect(coach.snapshot().current_depth).toBe(16);
    expect(analyze.snapshot().pvs).toHaveLength(2);
    await coach.close();
    await analyze.close();
    const returned = source.createHandle({ maxDepth: 16 });
    await returned.open({ fen: "A", multipv: 2 });
    expect(returned.snapshot().current_depth).toBe(16);
    expect(workers).toHaveLength(1);
  });

  it("fast A → B → A keeps A's search, and idle abandoned workers stop", async () => {
    const handle = source.createHandle({ maxDepth: 16 });
    await handle.open({ fen: "A" });
    await handle.update({ fen: "B" });
    await handle.update({ fen: "A" });
    expect(workers).toHaveLength(2);
    workers[0].finish(14);
    expect(handle.snapshot().fen).toBe("A");
    await vi.advanceTimersByTimeAsync(1600);
    expect(workers[1].close).toHaveBeenCalledOnce();
    expect(handle.snapshot().current_depth).toBe(14);
  });

  it("depth changes and MultiPV upgrades do not serve the wrong contract", async () => {
    const first = source.createHandle({ maxDepth: 12 });
    await first.open({ fen: "A" });
    workers[0].finish(12);
    first.snapshot();
    const deeper = source.createHandle({ maxDepth: 18 });
    await deeper.open({ fen: "A", multipv: 2 });
    expect(workers).toHaveLength(2);
    expect(deeper.snapshot().current_depth).toBe(0);
    await deeper.update({ fen: "A", multipv: 3 });
    expect(workers).toHaveLength(3);
    workers[2].finish(18);
    expect(deeper.snapshot().pvs).toHaveLength(3);
    expect(first.snapshot().current_depth).toBe(12);
  });

  it("does not expose a completed single-PV read while a wider search starts", async () => {
    const handle = source.createHandle({ maxDepth: 16 });
    await handle.open({ fen: "A" });
    workers[0].finish();
    expect(handle.snapshot().running).toBe(false);
    await handle.update({ fen: "A", multipv: 3 });
    expect(handle.snapshot().running).toBe(true);
    expect(handle.snapshot().pvs).toHaveLength(0);
  });

  it("clear while worker startup is pending cannot resurrect polling", async () => {
    source.clear();
    let resolve;
    const close = vi.fn(async () => {});
    source = createEvaluationSource({ createProvider: () => ({
      open: () => new Promise((yes) => { resolve = yes; }), close,
      snapshot: () => ({ fen: "A", pvs: [], running: true }),
    }) });
    const handle = source.createHandle({ maxDepth: 16 });
    const pending = handle.open({ fen: "A" });
    source.clear();
    resolve();
    await pending;
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds abandoned searches during fast stepping and retains partial reads", async () => {
    const handle = source.createHandle({ maxDepth: 16 });
    await handle.open({ fen: "A" });
    workers[0].finish(10);
    // A partial search continues; releasing it must preserve that read.
    const original = workers[0].snapshot;
    workers[0].snapshot = () => ({ ...original(), running: true });
    for (const fen of ["B", "C", "D", "E", "F", "G"]) await handle.update({ fen });
    expect(workers.filter((worker) => !worker.close.mock.calls.length)).toHaveLength(4);
    await handle.update({ fen: "A" });
    expect(handle.snapshot().current_depth).toBe(10);
    expect(handle.snapshot().running).toBe(true);
  });

  it("reuses published Analyze results without a worker and refuses a shallower replacement", async () => {
    source.publish("A", 16, { fen: "A", current_depth: 16, running: false, pvs: [{ score_cp: 50 }] });
    source.publish("A", 16, { fen: "A", current_depth: 10, running: false, pvs: [{ score_cp: 0 }] });
    const handle = source.createHandle({ maxDepth: 16 });
    await handle.open({ fen: "A" });
    expect(handle.snapshot().pvs[0].score_cp).toBe(50);
    expect(workers).toHaveLength(0);
  });
});
