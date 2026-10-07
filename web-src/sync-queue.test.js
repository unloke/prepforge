import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSyncQueue, loadDurableOutbox } from "./sync-queue.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("indexedDB", new IDBFactory());
  const locks = new Map();
  vi.stubGlobal("localStorage", { getItem: k => locks.get(k),
    setItem: (k, v) => locks.set(k, v), removeItem: k => locks.delete(k) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup(options = {}) {
  const state = { pending: [{ attempt_uuid: "u" }], retry: 0, timer: null, flushing: null };
  const flush = vi.fn(async checkpoint => { await checkpoint; return true; });
  const queue = createSyncQueue({ key: "train", tabId: "one", state: () => state,
    owner: () => "alice", generation: () => 1, idleMs: 4000,
    serialize: () => ({ train: { pending: state.pending } }),
    hasWork: () => state.pending.length, flush, ...options });
  return { state, flush, queue };
}

it("checkpoints before sending, survives reload, and dedupes stale replay", async () => {
  vi.useRealTimers(); // fake-indexeddb transactions use native task scheduling.
  const h = setup();
  const stale = h.state.pending;
  h.flush.mockImplementation(async checkpoint => {
    await checkpoint;
    expect((await loadDurableOutbox("alice")).train.pending).toEqual(stale);
    h.state.pending = [];
    await h.queue.persist({ train: ["u"] });
    return true;
  });
  expect(await h.queue.flush()).toBe(true);
  h.state.pending = stale;
  await h.queue.persist();
  expect((await loadDurableOutbox("alice")).train.pending).toEqual([]);
  expect((await loadDurableOutbox("bob")).train.pending).toEqual([]);
});

it("shares one in-flight promise while edits arriving during the flush stay queued", async () => {
  let finish;
  const h = setup({ persist: vi.fn(), flush: () => new Promise(resolve => { finish = resolve; }) });
  const first = h.queue.flush();
  h.state.pending.push({ attempt_uuid: "new" });
  expect(h.queue.flush()).toBe(first);
  finish(true); await first;
  expect(h.state.pending).toHaveLength(2);
  expect(h.state.flushing).toBeNull();
});

it("honours idle debounce, exponential backoff, retry-after and cancellation", async () => {
  const h = setup({ persist: vi.fn() });
  h.queue.schedule();
  await vi.advanceTimersByTimeAsync(3000); h.queue.schedule();
  await vi.advanceTimersByTimeAsync(3999); expect(h.flush).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(h.flush).toHaveBeenCalledTimes(1);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    h.queue.retry();
    const before = h.flush.mock.calls.length;
    await vi.advanceTimersByTimeAsync(delay - 1); expect(h.flush).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1); expect(h.flush).toHaveBeenCalledTimes(before + 1);
  }
  h.queue.retry({ retryAfterMs: 50 });
  await vi.advanceTimersByTimeAsync(50); expect(h.flush).toHaveBeenCalledTimes(9);
  h.queue.schedule(); h.queue.cancel();
  await vi.advanceTimersByTimeAsync(4000); expect(h.flush).toHaveBeenCalledTimes(9);
});

it("a held cross-tab lock retries without blocking the other queue", async () => {
  let finish;
  const one = setup({ persist: vi.fn(), flush: () => new Promise(resolve => { finish = resolve; }) });
  const two = setup({ tabId: "two", persist: vi.fn() });
  const build = setup({ key: "build", tabId: "two", persist: vi.fn() });
  const pending = one.queue.flush();
  expect(await two.queue.flush()).toBe(false);
  expect(two.flush).not.toHaveBeenCalled();
  expect(await build.queue.flush()).toBe(true);
  finish(true); await pending;
  await vi.advanceTimersByTimeAsync(4000);
  expect(two.flush).toHaveBeenCalledTimes(1);
});

it("an owner generation change invalidates the checkpoint and releases its promise", async () => {
  let epoch = 1, finish;
  const checkpoint = new Promise(resolve => { finish = resolve; });
  const send = vi.fn();
  const h = setup({ generation: () => epoch, persist: () => checkpoint,
    flush: async (durable, isCurrent) => { await durable; if (!isCurrent()) return false; send(); return true; } });
  const old = h.queue.flush(); epoch++;
  finish(true);
  expect(await old).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(h.state.flushing).toBeNull();
  expect(await h.queue.flush()).toBe(true);
  expect(send).toHaveBeenCalledOnce();
});
