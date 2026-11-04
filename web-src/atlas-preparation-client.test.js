import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAtlasPreparation } from "./atlas-preparation-client.js";

const input = { nodes: [{ id: "root", parent_id: null, fen: "start" }], myColor: "white" };
let workers, WorkerMock;
beforeEach(() => {
  workers = [];
  WorkerMock = vi.fn(function (url, options) {
    this.url = url;
    this.options = options;
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
    workers.push(this);
  });
  vi.stubGlobal("Worker", WorkerMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("one-shot Atlas preparation worker", () => {
  it("creates a module worker, posts the move-only input and terminates on success", () => {
    const onResult = vi.fn(), onError = vi.fn();
    const cancel = startAtlasPreparation(input, { onResult, onError });
    const worker = workers[0];
    expect(worker.url).toBeInstanceOf(URL);
    expect(worker.url.pathname).toMatch(/\/atlas-preparation-worker\.js$/);
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage.mock.calls[0][0]).toMatchObject(input);
    const result = { score: 42, facets: [], counts: {} };
    worker.onmessage({ data: { result } });
    expect(onResult).toHaveBeenCalledExactlyOnceWith(result);
    expect(onError).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    cancel();
    worker.onmessage({ data: { result: { score: 99 } } });
    expect(onResult).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("cancels idempotently and ignores queued success and error callbacks", () => {
    const onResult = vi.fn(), onError = vi.fn();
    const cancel = startAtlasPreparation(input, { onResult, onError });
    const worker = workers[0];
    cancel();
    cancel();
    worker.onmessage({ data: { result: { score: 1 } } });
    worker.onmessage({ data: { error: "late failure" } });
    worker.onerror({ message: "late crash" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not deliver a stale request after its replacement finishes", () => {
    const oldResult = vi.fn(), newResult = vi.fn();
    const cancel = startAtlasPreparation(input, { onResult: oldResult, onError: vi.fn() });
    cancel();
    startAtlasPreparation({ ...input, rootNodeId: "branch" }, { onResult: newResult, onError: vi.fn() });
    workers[1].onmessage({ data: { result: { score: 30 } } });
    workers[0].onmessage({ data: { result: { score: 80 } } });
    expect(oldResult).not.toHaveBeenCalled();
    expect(newResult).toHaveBeenCalledExactlyOnceWith({ score: 30 });
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it("surfaces calculation errors once and terminates", () => {
    const onError = vi.fn(), onResult = vi.fn();
    startAtlasPreparation(input, { onResult, onError });
    const worker = workers[0];
    worker.onmessage({ data: { error: "Illegal repertoire move" } });
    worker.onerror({ message: "duplicate failure" });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe("Illegal repertoire move");
    expect(onResult).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("surfaces worker crashes and terminates", () => {
    const onError = vi.fn();
    startAtlasPreparation(input, { onResult: vi.fn(), onError });
    workers[0].onerror({ message: "Worker module failed to load" });
    expect(onError.mock.calls[0][0].message).toBe("Worker module failed to load");
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("surfaces construction errors without synchronous calculation", () => {
    WorkerMock.mockImplementationOnce(function () { throw new Error("Worker blocked"); });
    const onError = vi.fn(), onResult = vi.fn();
    const cancel = startAtlasPreparation(input, { onResult, onError });
    expect(onError.mock.calls[0][0].message).toBe("Worker blocked");
    expect(onResult).not.toHaveBeenCalled();
    expect(cancel).toBeTypeOf("function");
    expect(() => { cancel(); cancel(); }).not.toThrow();
  });

  it("terminates and surfaces a postMessage failure", () => {
    WorkerMock.mockImplementationOnce(function () {
      this.postMessage = () => { throw new Error("Cannot clone input"); };
      this.terminate = vi.fn();
      workers.push(this);
    });
    const onError = vi.fn();
    startAtlasPreparation(input, { onResult: vi.fn(), onError });
    expect(onError.mock.calls[0][0].message).toBe("Cannot clone input");
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("never reads or serializes massive comments or other non-move fields", () => {
    const node = { ...input.nodes[0], uci: null, is_enabled: true,
      is_prepared: false, is_mainline: false, typical_plan: "x".repeat(2_000_000),
      tags: ["ignored"], arrows: ["a1a8"], engine_evaluation: { score_cp: 800 } };
    Object.defineProperty(node, "comment", { enumerable: true,
      get() { throw new Error("Annotations must not be read"); } });
    startAtlasPreparation({ nodes: [node], myColor: "black", rootNodeId: "root", horizon: 16,
      notes: "x".repeat(2_000_000) }, { onResult: vi.fn(), onError: vi.fn() });
    const payload = workers[0].postMessage.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(["horizon", "myColor", "nodes", "rootNodeId"]);
    expect(Object.keys(payload.nodes[0]).sort()).toEqual(
      ["id", "parent_id", "fen", "uci", "is_enabled", "is_prepared", "is_mainline"].sort());
    expect(JSON.stringify(payload).length).toBeLessThan(400);
  });
});
