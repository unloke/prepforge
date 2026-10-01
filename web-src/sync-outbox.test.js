import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireFlushLock,
  buildAddId,
  buildDeleteId,
  clearOutbox,
  loadOutbox,
  mergeOutboxState,
  outboxHasRejected,
  outboxHasWork,
  outboxIsQuiescent,
  outboxKey,
  releaseFlushLock,
  saveOutbox,
  trainAttemptId,
} from "./sync-outbox.js";

// Durable owner-scoped outbox (R-03): unsynced Build/Train edits survive a
// reload, signing in as B never replays A's queue, rejected ops are kept for
// inspection (never silently dropped), and a cross-tab lock stops two tabs
// from double-sending the same queue.

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

describe("sync-outbox storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scopes keys per owner so one account never sees another's queue", () => {
    expect(outboxKey("a")).not.toBe(outboxKey("b"));
    expect(outboxKey(null)).toBe(outboxKey(undefined));
    expect(outboxKey()).toContain("anon");

    saveOutbox("a", {
      build: { pending: [buildEntry], pendingDeletes: [], idMap: {}, rejected: [] },
      train: { pending: [], rejected: [] },
    });
    expect(loadOutbox("b").build.pending).toHaveLength(0);
    expect(loadOutbox("a").build.pending).toEqual([buildEntry]);
  });

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
    expect(saveOutbox("owner", state)).toBe(true);
    const loaded = loadOutbox("owner");
    expect(loaded.build).toEqual(state.build);
    expect(loaded.train).toEqual(state.train);
    clearOutbox("owner");
    expect(loadOutbox("owner").build.pending).toEqual([buildEntry]);
  });

  it("normalizes corrupt or partial payloads instead of throwing", () => {
    localStorage.setItem(outboxKey("x"), "{not json");
    const corrupt = loadOutbox("x");
    expect(corrupt.build.pending).toEqual([]);
    expect(corrupt.train.rejected).toEqual([]);

    localStorage.setItem(outboxKey("x"), JSON.stringify({ build: { pending: "nope" } }));
    const partial = loadOutbox("x");
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

  it("degrades to permissive behaviour when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(saveOutbox("owner", {})).toBe(false);
    expect(loadOutbox("owner").build.pending).toEqual([]);
    expect(acquireFlushLock("owner", "tab")).toBe(true);
    expect(() => clearOutbox("owner")).not.toThrow();
    expect(() => releaseFlushLock("tab")).not.toThrow();
  });
});

describe("cross-tab flush lock", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps Train work when Build drains (and the reverse)", () => {
    saveOutbox("owner", {
      ...empty,
      build: { ...empty.build, pending: [buildEntry] },
      train: { pending: [{ attempt_uuid: "u1" }], rejected: [] },
    });
    // Build's queue empties and is confirmed: only Build's op is tombstoned.
    saveOutbox(
      "owner",
      { ...empty, train: { pending: [{ attempt_uuid: "u1" }], rejected: [] } },
      { build: [buildAddId(buildEntry)] },
    );
    let stored = loadOutbox("owner");
    expect(stored.build.pending).toHaveLength(0);
    expect(stored.train.pending).toHaveLength(1);

    // Train's queue drains too: only now is the owner's copy droppable.
    expect(outboxIsQuiescent(stored)).toBe(false);
    saveOutbox("owner", empty, { train: ["u1"] });
    stored = loadOutbox("owner");
    expect(outboxIsQuiescent(stored)).toBe(true);
  });

  it("never reports quiescent while rejected ops are kept for review", () => {
    const rejected = { kind: "add", tempId: "bad", message: "nope" };
    saveOutbox("owner", { ...empty, build: { ...empty.build, rejected: [rejected] } });
    const stored = loadOutbox("owner");
    expect(outboxHasWork(stored)).toBe(false);
    expect(outboxIsQuiescent(stored)).toBe(false);
  });

  it("merges a stale tab's write instead of overwriting newer ops (R-04)", () => {
    saveOutbox("owner", {
      ...empty,
      build: { ...empty.build, pending: [{ tempId: "t2", parentRef: "r", uci: "d2d4" }] },
    });
    // Tab B still believes the queue is empty and writes its own view.
    saveOutbox("owner", empty);
    expect(loadOutbox("owner").build.pending.map(buildAddId)).toEqual(["t2"]);

    // Tab B's own op lands alongside it.
    saveOutbox("owner", {
      ...empty,
      build: { ...empty.build, pending: [{ tempId: "t9", parentRef: "r", uci: "g1f3" }] },
    });
    expect(loadOutbox("owner").build.pending.map(buildAddId)).toEqual(["t2", "t9"]);
  });

  it("settles deletes and train attempts by their own identities", () => {
    const state = {
      ...empty,
      build: { ...empty.build, pendingDeletes: [{ id: "n1" }, { id: "n2" }] },
      train: { pending: [{ attempt_uuid: "u1" }, { attempt_uuid: "u2" }], rejected: [] },
    };
    saveOutbox("owner", state);
    saveOutbox("owner", empty, { deletes: ["n1"], train: ["u1"] });
    const stored = loadOutbox("owner");
    expect(stored.build.pendingDeletes.map(buildDeleteId)).toEqual(["n2"]);
    expect(stored.train.pending.map(trainAttemptId)).toEqual(["u2"]);
  });

  it("keeps the tmp -> real id map additive across tabs", () => {
    saveOutbox("owner", {
      ...empty,
      build: { ...empty.build, idMap: { "tmp-1": "real-1" } },
    });
    saveOutbox("owner", {
      ...empty,
      build: { ...empty.build, idMap: { "tmp-2": "real-2" } },
    });
    expect(loadOutbox("owner").build.idMap).toEqual({ "tmp-1": "real-1", "tmp-2": "real-2" });
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
      saveOutbox("owner", {
        ...empty,
        build: { ...empty.build, rejected: [{ kind: "add", tempId: `bad-${i}` }] },
      });
    }
    const rejected = loadOutbox("owner").build.rejected;
    expect(rejected).toHaveLength(100);
    // The newest rejections survive — those are the ones being worked on.
    expect(rejected[rejected.length - 1].tempId).toBe("bad-139");
  });  it("falls back to a stable identity for entries without one", () => {
    expect(buildAddId({ uci: "e2e4" })).toBe("");
    expect(trainAttemptId({ session_id: "s", node_id: "n", correct: true })).toBe("s:n:true");
  });

  // R-04: two tabs share ONE localStorage key, so identity must be unique per
  // tab, not per tab-counter. A per-tab counter restarts at 1, so without the
  // tab id both tabs mint "tmp-1" for DIFFERENT moves: the merge then treats the
  // second tab's brand-new move as the first tab's settled op and drops it from
  // the durable queue — the move is lost silently on close.
  it("keeps two tabs' identically-numbered moves apart (temp ids are tab-scoped)", () => {
    const tabA = { tempId: "tmp-aaa-1", uci: "e2e4" };
    const tabB = { tempId: "tmp-bbb-1", uci: "d2d4" };

    // Tab A flushes and settles its own op.
    const afterA = saveOutbox("owner", empty, { build: [buildAddId(tabA)] });
    expect(afterA).toBe(true);
    expect(loadOutbox("owner").build.pending).toHaveLength(0);

    // Tab B persists its own move; it must survive AND not resurrect A's.
    saveOutbox("owner", {
      ...empty,
      build: { ...empty.build, pending: [tabB] },
    });
    const stored = loadOutbox("owner");
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

