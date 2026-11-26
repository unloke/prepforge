import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeOutboxMerge } from "./outbox-state.js";
import { buildAddId, buildDeleteId, buildOutbox } from "./build-outbox.js";
import { trainAttemptId, trainOutbox } from "./train-outbox.js";
import { acquireFlushLock, createSyncQueue, refreshFlushLock, releaseFlushLock } from "./sync-queue.js";

// Outbox merge rules (R-03/R-04): rejected training attempts are kept, rejected
// Build edits are reported once and dropped, settled ops never return, and a cross-tab lock stops two
// tabs from double-sending the same queue. Each feature merges its own slice
// (build-outbox.js, train-outbox.js); storage itself is outbox-db.js.

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const buildEntry = { tempId: "t1", parentRef: "root", uci: "e2e4" };

const mergeOutboxState = composeOutboxMerge([buildOutbox, trainOutbox]);
const hasWork = (state) => !!(state.build.pending.length || state.build.pendingDeletes.length
  || state.train.pending.length);
const isQuiescent = (state) => !hasWork(state) && !state.train.rejected.length;

// The merge applied by every durable write, without the IndexedDB transport.
function memoryOutbox() {
  let state = null;
  return {
    save(incoming, settled = null) { state = mergeOutboxState(state, incoming, settled); },
    load: () => mergeOutboxState(state, null),
  };
}

describe("outbox state", () => {
  it("round-trips the queue and keeps rejected training attempts", () => {
    const state = {
      build: {
        pending: [buildEntry],
        pendingDeletes: [{ tempId: "d1" }],
        idMap: { t1: 11 },
      },
      train: { pending: [{ attempt: "u1" }], rejected: [{ sessionId: "s", attempts: [], status: 422 }] },
    };
    const box = memoryOutbox();
    box.save(state);
    expect(box.load().build).toMatchObject(state.build);
    expect(box.load().train).toMatchObject(state.train);
  });

  it("normalizes partial payloads instead of throwing", () => {
    const partial = mergeOutboxState(null, { build: { pending: "nope" } });
    expect(partial.build.pending).toEqual([]);
    expect(partial.build.pendingDeletes).toEqual([]);
    expect(partial.build.idMap).toEqual({});
  });

  it("keeps each feature's slice to itself", () => {
    // A feature's merge sees only its own slice and its own settled ids: an id
    // that happens to match across features settles nothing in the other one.
    const merged = mergeOutboxState(null, {
      build: { pending: [{ tempId: "same", uci: "e2e4" }] },
      train: { pending: [{ attempt_uuid: "same" }] },
    }, { train: ["same"] });
    expect(merged.build.pending.map(buildAddId)).toEqual(["same"]);
    expect(merged.train.pending).toEqual([]);
    expect(Object.keys(merged)).toEqual(["build", "train"]);
  });
});

describe("cross-tab flush lock", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("degrades to permissive behaviour when storage is blocked", () => {
    const blocked = () => { throw new Error("blocked"); };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(acquireFlushLock("owner", "tab", 1000, "build")).toBe(true);
    expect(() => releaseFlushLock("tab", "build")).not.toThrow();
  });

  it("blocks a second tab but lets the same tab re-acquire", () => {
    expect(acquireFlushLock("owner", "tab-1", 1000, "build")).toBe(true);
    expect(acquireFlushLock("owner", "tab-1", 1100, "build")).toBe(true);
    expect(acquireFlushLock("owner", "tab-2", 1200, "build")).toBe(false);
  });

  it("steals a lock whose holder stopped renewing it (a dead tab)", () => {
    expect(acquireFlushLock("owner", "tab-1", 1000, "build")).toBe(true);
    // The holder renews while it works, so only a holder that stopped (a crash)
    // lets the lease run out — in seconds, not in half a minute.
    expect(acquireFlushLock("owner", "tab-2", 5_000, "build")).toBe(false);
    expect(acquireFlushLock("owner", "tab-2", 9_500, "build")).toBe(true);
  });

  it("renews the holder's lease without touching someone else's lock", () => {
    expect(acquireFlushLock("owner", "tab-1", 1000, "build")).toBe(true);
    expect(refreshFlushLock("tab-1", "build", 6_000)).toBe(true);
    // Renewed: the lock is still held, now until 6s + the lease.
    expect(acquireFlushLock("owner", "tab-2", 8_000, "build")).toBe(false);
    expect(refreshFlushLock("tab-2", "build", 8_000)).toBe(false);
  });

  it("ignores locks held for a different owner", () => {
    expect(acquireFlushLock("owner-a", "tab-1", 1000, "build")).toBe(true);
    expect(acquireFlushLock("owner-b", "tab-2", 1100, "build")).toBe(true);
  });

  it("releases only its own tab's lock", () => {
    acquireFlushLock("owner", "tab-1", 1000, "build");
    releaseFlushLock("tab-2", "build");
    expect(acquireFlushLock("owner", "tab-2", 1100, "build")).toBe(false);
    releaseFlushLock("tab-1", "build");
    expect(acquireFlushLock("owner", "tab-2", 1200, "build")).toBe(true);
  });
});

// R-01: one feature finishing must never erase the other's unsynced work, and
// nothing may be dropped while anything is still kept for review.

describe("outbox settling", () => {
  const empty = {
    build: { pending: [], pendingDeletes: [], idMap: {} },
    train: { pending: [], rejected: [] },
  };

  let box;
  beforeEach(() => {
    box = memoryOutbox();
  });

  it("keeps Train work when Build drains (and the reverse)", () => {
    box.save({
      ...empty,
      build: { ...empty.build, pending: [buildEntry] },
      train: { pending: [{ attempt_uuid: "u1" }], rejected: [] },
    });
    // Build's queue empties and is confirmed: only Build's op is tombstoned.
    box.save({ ...empty, train: { pending: [{ attempt_uuid: "u1" }], rejected: [] } },
      { build: { adds: [buildAddId(buildEntry)] } },
    );
    let stored = box.load();
    expect(stored.build.pending).toHaveLength(0);
    expect(stored.train.pending).toHaveLength(1);

    // Train's queue drains too: only now is the owner's copy droppable.
    expect(isQuiescent(stored)).toBe(false);
    box.save(empty, { train: ["u1"] });
    stored = box.load();
    expect(isQuiescent(stored)).toBe(true);
  });

  it("never reports quiescent while rejected ops are kept for review", () => {
    box.save({ ...empty, train: { ...empty.train, rejected: [{ sessionId: "s", attempts: [], status: 422 }] } });
    const stored = box.load();
    expect(hasWork(stored)).toBe(false);
    expect(isQuiescent(stored)).toBe(false);
  });

  it("merges a stale tab's write instead of overwriting newer ops (R-04)", () => {
    box.save({
      ...empty,
      build: { ...empty.build, pending: [{ tempId: "t2", parentRef: "r", uci: "d2d4" }] },
    });
    // Tab B still believes the queue is empty and writes its own view.
    box.save(empty);
    expect(box.load().build.pending.map(buildAddId)).toEqual(["t2"]);

    // Tab B's own op lands alongside it.
    box.save({
      ...empty,
      build: { ...empty.build, pending: [{ tempId: "t9", parentRef: "r", uci: "g1f3" }] },
    });
    expect(box.load().build.pending.map(buildAddId)).toEqual(["t2", "t9"]);
  });

  it("settles deletes and train attempts by their own identities", () => {
    const state = {
      ...empty,
      build: { ...empty.build, pendingDeletes: [{ id: "n1" }, { id: "n2" }] },
      train: { pending: [{ attempt_uuid: "u1" }, { attempt_uuid: "u2" }], rejected: [] },
    };
    box.save(state);
    box.save(empty, { build: { deletes: ["n1"] }, train: ["u1"] });
    const stored = box.load();
    expect(stored.build.pendingDeletes.map(buildDeleteId)).toEqual(["n2"]);
    expect(stored.train.pending.map(trainAttemptId)).toEqual(["u2"]);
  });

  it("keeps the tmp -> real id map additive across tabs", () => {
    box.save({
      ...empty,
      build: { ...empty.build, idMap: { "tmp-1": "real-1" } },
    });
    box.save({
      ...empty,
      build: { ...empty.build, idMap: { "tmp-2": "real-2" } },
    });
    expect(box.load().build.idMap).toEqual({ "tmp-1": "real-1", "tmp-2": "real-2" });
  });

  it("mergeOutboxState drops settled ops from the STORED copy too", () => {
    const stored = {
      ...empty,
      build: { ...empty.build, pending: [buildEntry] },
    };
    const merged = mergeOutboxState(stored, empty, { build: { adds: [buildAddId(buildEntry)] } });
    expect(merged.build.pending).toHaveLength(0);
  });

  it("drops stored rejected Build edits: they are reported once, not kept", () => {
    box.save({ ...empty, build: { ...empty.build, rejected: [{ kind: "add", tempId: "bad" }] } });
    expect(box.load().build.rejected).toBeUndefined();
    expect(isQuiescent(box.load())).toBe(true);
  });

  it("requires attempt UUIDs rather than deriving identities from grades", () => {
    expect(buildAddId({ uci: "e2e4" })).toBe("");
    expect(trainAttemptId({ session_id: "s", node_id: "n", correct: true })).toBe("");
  });

  // R-04: two tabs share ONE owner record, so identity must be unique per
  // tab, not per tab-counter. A per-tab counter restarts at 1, so without the
  // tab id both tabs mint "tmp-1" for DIFFERENT moves: the merge then treats the
  // second tab's brand-new move as the first tab's settled op and drops it from
  // the durable queue — the move is lost silently on close.
  it("keeps two tabs' identically-numbered moves apart (temp ids are tab-scoped)", () => {
    const tabA = { tempId: "tmp-aaa-1", uci: "e2e4" };
    const tabB = { tempId: "tmp-bbb-1", uci: "d2d4" };

    // Tab A flushes and settles its own op.
    box.save(empty, { build: { adds: [buildAddId(tabA)] } });
    expect(box.load().build.pending).toHaveLength(0);

    // Tab B persists its own move; it must survive AND not resurrect A's.
    box.save({
      ...empty,
      build: { ...empty.build, pending: [tabB] },
    });
    const stored = box.load();
    expect(stored.build.pending.map(buildAddId)).toEqual(["tmp-bbb-1"]);
    expect(stored.build.settled.adds).toContain("tmp-aaa-1");
  });

  it("would drop a colliding id — which is why app.js mints per-tab temp ids", () => {
    // Pins the failure mode the tab-scoped id prevents. If this ever starts
    // returning the entry again the merge semantics changed underneath us.
    const collided = { tempId: "tmp-1", uci: "d2d4" };
    const merged = mergeOutboxState(empty, {
      ...empty,
      build: { ...empty.build, pending: [collided] },
    }, { build: { adds: ["tmp-1"] } });
    expect(merged.build.pending).toHaveLength(0);
  });
});
describe("flush lock and the page that took it", () => {
  let handlers;
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
    handlers = {};
    vi.stubGlobal("addEventListener", (type, fn) => { handlers[type] = fn; });
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function queueWithStuckFlush() {
    const state = { pending: [1], dirty: false, timer: null, flushing: null, retry: 0 };
    const queue = createSyncQueue({
      key: "train",
      state: () => state,
      owner: () => "owner",
      generation: () => 1,
      serialize: () => ({}),
      persist: () => Promise.resolve(true),
      hasWork: () => true,
      idleMs: 10,
      tabId: "tab-1",
      flush: () => new Promise(() => {}), // never settles: the page dies with it
    });
    return { queue, state };
  }

  it("defers a late visibility flush until pageshow", async () => {
    const { queue } = queueWithStuckFlush();
    handlers.pagehide({ persisted: true });
    await expect(queue.flush()).resolves.toBe(false);
    expect(handlers.unload).toBeUndefined();

    handlers.pageshow({ persisted: true });
    void queue.flush();
    expect(acquireFlushLock("owner", "tab-2", 1000, "train")).toBe(false);
  });
});
