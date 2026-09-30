import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireFlushLock,
  clearOutbox,
  loadOutbox,
  outboxHasRejected,
  outboxHasWork,
  outboxKey,
  releaseFlushLock,
  saveOutbox,
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
    expect(loadOutbox("owner")).toEqual(state);
    clearOutbox("owner");
    expect(loadOutbox("owner").build.pending).toHaveLength(0);
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
