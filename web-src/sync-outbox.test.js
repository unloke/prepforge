import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireFlushLock,
  buildAddId,
  buildDeleteId,
  mergeOutboxState,
  outboxHasRejected,
  outboxHasWork,
  outboxIsQuiescent,
  releaseFlushLock,
  trainAttemptId,
} from "./sync-queue.js";

// Outbox merge rules (R-03/R-04): rejected ops are kept for inspection (never
// silently dropped), settled ops never return, and a cross-tab lock stops two
// tabs from double-sending the same queue. Storage itself is outbox-db.js.

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

// The merge applied by every durable write, without the IndexedDB transport.
function memoryOutbox() {
  let state = null;
  return {
    save(incoming, settled = null) { state = mergeOutboxState(state, incoming, settled); },
    load: () => mergeOutboxState(state, null),
  };
}

describe("outbox state", () => {
  it("round-trips the queue and keeps rejected ops for inspection", () => {
    const state = {
      build: {
        pending: [buildEntry],
        pendingDeletes: [{ tempId: "d1" }],
        idMap: { t1: 11 },
        rejected: [{ tempId: "bad", error: "validation" }],
      },
      train: { pending: [{ attempt: "u1" }], rejected: [] },
    };
    const box = memoryOutbox();
    box.save(state);
    expect(box.load().build).toEqual(state.build);
    expect(box.load().train).toEqual(state.train);
  });

  it("normalizes partial payloads instead of throwing", () => {
    const partial = mergeOutboxState(null, { build: { pending: "nope" } });
    expect(partial.build.pending).toEqual([]);
    expect(partial.build.pendingDeletes).toEqual([]);
    expect(partial.build.idMap).toEqual({});
  });

  it("reports pending work and rejected ops separately", () => {
    const empty = {
      build: { pending: [], pendingDeletes: [], idMap: {}, rejected: [] },
      train: { pending: [], rejected: [] },
    };
    expect(outboxHasWork(empty)).toBe(false);
    expect(outboxHasRejected(empty)).toBe(false);
    expect(outboxHasWork({ ...empty, build: { ...empty.build, pending: [buildEntry] } })).toBe(true);
    expect(
      outboxHasWork({ ...empty, build: { ...empty.build, pendingDeletes: [{ tempId: "d" }] } }),
    ).toBe(true);
    expect(outboxHasWork({ ...empty, train: { ...empty.train, pending: [{}] } })).toBe(true);
    // Rejected ops are for the user to act on — they are NOT auto-retried work.
    const rejected = { ...empty, build: { ...empty.build, rejected: [buildEntry] } };
    expect(outboxHasWork(rejected)).toBe(false);
    expect(outboxHasRejected(rejected)).toBe(true);
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
    expect(acquireFlushLock("owner", "tab")).toBe(true);
    expect(() => releaseFlushLock("tab")).not.toThrow();
  });

  it("blocks a second tab but lets the same tab re-acquire", () => {
    expect(acquireFlushLock("owner", "tab-1", 1000)).toBe(true);
    expect(acquireFlushLock("owner", "tab-1", 1100)).toBe(true);
    expect(acquireFlushLock("owner", "tab-2", 1200)).toBe(false);
  });

  it("steals a stale lock (holder went silent for 30s)", () => {
    expect(acquireFlushLock("owner", "tab-1", 1000)).toBe(true);
    expect(acquireFlushLock("owner", "tab-2", 31_000)).toBe(true);
  });

  it("ignores locks held for a different owner", () => {
    expect(acquireFlushLock("owner-a", "tab-1", 1000)).toBe(true);
    expect(acquireFlushLock("owner-b", "tab-2", 1100)).toBe(true);
  });

  it("releases only its own tab's lock", () => {
    acquireFlushLock("owner", "tab-1", 1000);
    releaseFlushLock("tab-2");
    expect(acquireFlushLock("owner", "tab-2", 1100)).toBe(false);
    releaseFlushLock("tab-1");
    expect(acquireFlushLock("owner", "tab-2", 1200)).toBe(true);
  });
});

// R-01: one feature finishing must never erase the other's unsynced work, and
// nothing may be dropped while anything is still kept for review.

describe("outbox settling", () => {
  const empty = {
    build: { pending: [], pendingDeletes: [], idMap: {}, rejected: [] },
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
      { build: [buildAddId(buildEntry)] },
    );
    let stored = box.load();
    expect(stored.build.pending).toHaveLength(0);
    expect(stored.train.pending).toHaveLength(1);

    // Train's queue drains too: only now is the owner's copy droppable.
    expect(outboxIsQuiescent(stored)).toBe(false);
    box.save(empty, { train: ["u1"] });
    stored = box.load();
    expect(outboxIsQuiescent(stored)).toBe(true);
  });

  it("never reports quiescent while rejected ops are kept for review", () => {
    const rejected = { kind: "add", tempId: "bad", message: "nope" };
    box.save({ ...empty, build: { ...empty.build, rejected: [rejected] } });
    const stored = box.load();
    expect(outboxHasWork(stored)).toBe(false);
    expect(outboxIsQuiescent(stored)).toBe(false);
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
    box.save(empty, { deletes: ["n1"], train: ["u1"] });
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
    const merged = mergeOutboxState(stored, empty, { build: [buildAddId(buildEntry)] });
    expect(merged.build.pending).toHaveLength(0);
  });

  it("bounds the rejected tail so a device can't grow without limit", () => {
    for (let i = 0; i < 140; i += 1) {
      box.save({
        ...empty,
        build: { ...empty.build, rejected: [{ kind: "add", tempId: `bad-${i}` }] },
      });
    }
    const rejected = box.load().build.rejected;
    expect(rejected).toHaveLength(140);
    // The newest rejections survive — those are the ones being worked on.
    expect(rejected[rejected.length - 1].tempId).toBe("bad-139");
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
    box.save(empty, { build: [buildAddId(tabA)] });
    expect(box.load().build.pending).toHaveLength(0);

    // Tab B persists its own move; it must survive AND not resurrect A's.
    box.save({
      ...empty,
      build: { ...empty.build, pending: [tabB] },
    });
    const stored = box.load();
    expect(stored.build.pending.map(buildAddId)).toEqual(["tmp-bbb-1"]);
    expect(stored.settled.build).toContain("tmp-aaa-1");
  });

  it("would drop a colliding id — which is why app.js mints per-tab temp ids", () => {
    // Pins the failure mode the tab-scoped id prevents. If this ever starts
    // returning the entry again the merge semantics changed underneath us.
    const collided = { tempId: "tmp-1", uci: "d2d4" };
    const merged = mergeOutboxState(empty, {
      ...empty,
      build: { ...empty.build, pending: [collided] },
    }, { build: ["tmp-1"] });
    expect(merged.build.pending).toHaveLength(0);
  });
});

