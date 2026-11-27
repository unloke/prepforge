// The durable outbox is feature-blind (outbox.js): any domain that brings its
// own slice, merge, queue state and flush gets the shared lifecycle — one
// checkpoint before anything is sent, settled ids filed under its own key,
// restore per slice, and the drain before sign-out.
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOutbox } from "./outbox.js";
import { asArray, mergeById, tombstones } from "./outbox-state.js";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const locks = new Map();
  vi.stubGlobal("localStorage", { getItem: k => locks.get(k),
    setItem: (k, v) => locks.set(k, v), removeItem: k => locks.delete(k) });
});
afterEach(() => { vi.unstubAllGlobals(); });

// A made-up feature, so nothing here leans on Build's or Train's rules.
function notesDomain(key = "notes") {
  const live = { pending: [], timer: null, flushing: null, retry: 0 };
  const id = (op) => String(op?.id || "");
  const domain = {
    key, idleMs: 10, live,
    merge(stored, incoming, settled) {
      const done = tombstones(stored?.settled, settled);
      const keep = (op) => !done.has(id(op));
      return { pending: mergeById(asArray(stored?.pending).filter(keep), asArray(incoming?.pending).filter(keep), id),
        settled: [...done] };
    },
    state: () => live,
    hasWork: () => live.pending.length,
    pendingCount: () => live.pending.length,
    snapshot: () => ({ pending: live.pending }),
    restore(slice) { live.pending = slice.pending.concat(live.pending); return live.pending.length; },
    flush: vi.fn(async (checkpoint) => { await checkpoint; return true; }),
    attach({ queue, persist }) { domain.queue = queue; domain.persist = persist; },
  };
  return domain;
}

function outboxFor(domains, extra = {}) {
  let owner = "alice", epoch = 1;
  const onPersist = vi.fn();
  const outbox = createOutbox({ domains, owner: () => owner, generation: () => epoch, tabId: "tab", onPersist, ...extra });
  return { outbox, onPersist, switchOwner(next) { owner = next; epoch += 1; } };
}

it("checkpoints before sending, survives reload, and dedupes a stale replay", async () => {
  const notes = notesDomain();
  const { outbox } = outboxFor([notes]);
  notes.live.pending = [{ id: "n1" }];
  const stale = notes.live.pending;
  notes.flush.mockImplementation(async (checkpoint) => {
    await checkpoint;
    // On disk before the request goes out.
    expect((await outbox.load()).notes.pending).toEqual(stale);
    notes.live.pending = [];
    await notes.persist(["n1"]); // filed under the domain's own key
    return true;
  });
  expect(await notes.queue.flush()).toBe(true);
  notes.live.pending = stale; // a stale tab writes its old view back
  await outbox.persist();
  expect((await outbox.load()).notes.pending).toEqual([]);
  expect((await outbox.load("bob")).notes.pending).toEqual([]);
});

it("keeps each domain's slice and settled ids to itself", async () => {
  const one = notesDomain("one"), two = notesDomain("two");
  const { outbox } = outboxFor([one, two]);
  one.live.pending = [{ id: "x" }];
  two.live.pending = [{ id: "x" }];
  await outbox.persist();
  await one.persist(["x"]);
  one.live.pending = [];
  const stored = await outbox.load();
  expect(stored.one.pending).toEqual([]);
  expect(stored.two.pending).toEqual([{ id: "x" }]);
});

it("restores each domain from its own slice, and nothing for an owner that changed meanwhile", async () => {
  const notes = notesDomain(), other = notesDomain("other");
  const { outbox, switchOwner } = outboxFor([notes, other]);
  notes.live.pending = [{ id: "a" }];
  await outbox.persist();
  notes.live.pending = [];
  expect(await outbox.restore()).toEqual({ notes: 1, other: 0 });
  expect(notes.live.pending).toEqual([{ id: "a" }]);

  notes.live.pending = [];
  const restoring = outbox.restore();
  switchOwner("bob");
  expect(await restoring).toBeNull();
  expect(notes.live.pending).toEqual([]);
});

it("drains every domain before sign-out and reports what is still unsent", async () => {
  const notes = notesDomain(), stuck = notesDomain("stuck");
  const { outbox } = outboxFor([notes, stuck]);
  // A flush may cover only part of a queue: the drain keeps going while each saves.
  notes.live.pending = [{ id: "1" }, { id: "2" }];
  notes.flush.mockImplementation(async (checkpoint) => { await checkpoint; notes.live.pending.shift(); return true; });
  stuck.live.pending = [{ id: "offline" }];
  stuck.flush.mockImplementation(async (checkpoint) => { await checkpoint; return false; });
  notes.queue.schedule();
  expect(await outbox.drain()).toEqual({ pending: 1 });
  expect(notes.flush).toHaveBeenCalledTimes(2);
  expect(stuck.flush).toHaveBeenCalledTimes(1);
  expect(notes.live.timer).toBeNull();
  expect((await outbox.load()).stuck.pending).toEqual([{ id: "offline" }]);
});

it("reports a checkpoint that could not be stored", async () => {
  const notes = notesDomain();
  const { outbox, onPersist } = outboxFor([notes]);
  vi.stubGlobal("indexedDB", { open() { throw new Error("blocked"); } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await outbox.persist()).toBe(false);
  expect(onPersist).toHaveBeenLastCalledWith(false);
});

// Review of #330: a flush already in flight holds its batch outside the queue,
// so the drain saw an empty queue and reported nothing unsent while the
// request was still out. Sign-out must wait for it, and count what it failed.
function inFlightDomain() {
  const notes = notesDomain();
  let finish;
  notes.flush.mockImplementation(async (checkpoint) => {
    await checkpoint;
    const batch = notes.live.pending;
    notes.live.pending = []; // the batch leaves the queue while it is sent
    const ok = await new Promise((resolve) => { finish = resolve; });
    if (!ok) notes.live.pending = batch.concat(notes.live.pending);
    return ok;
  });
  return { notes, finish: (ok) => finish(ok), started: () => typeof finish === "function" };
}

it("waits for a flush already in flight before reporting sign-out", async () => {
  const { notes, finish, started } = inFlightDomain();
  const { outbox } = outboxFor([notes]);
  notes.live.pending = [{ id: "sent" }];
  const flushing = notes.queue.flush();
  await vi.waitFor(() => expect(started()).toBe(true));
  let drained = null;
  const draining = outbox.drain().then((result) => { drained = result; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(drained).toBeNull(); // still waiting on the request
  finish(true);
  await draining;
  expect(drained).toEqual({ pending: 0 });
  expect(await flushing).toBe(true);
});

it("counts the batch of an in-flight flush that fails as unsent at sign-out", async () => {
  const { notes, finish, started } = inFlightDomain();
  const { outbox } = outboxFor([notes]);
  notes.live.pending = [{ id: "lost" }];
  void notes.queue.flush();
  await vi.waitFor(() => expect(started()).toBe(true));
  const draining = outbox.drain();
  finish(false);
  expect(await draining).toEqual({ pending: 1 });
  expect((await outbox.load()).notes.pending).toEqual([{ id: "lost" }]);
});
