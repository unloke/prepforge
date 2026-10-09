import { describe, expect, it } from "vitest";
import { clearSessionMemo, loadSessionMemo, saveSessionMemo } from "./train-session-memo.js";
import { saveSmartSession } from "./train-session-memo.js";
import { afterEach } from "vitest";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

const stats = { skipped: 0, correct: 1, mistakes: 1, streak: 0, best: 1, history: [true, false], lastStreak: 0 };

const progress = { queue: [{ encoded: "card", targets: [{ uci: "e2e4" }] }], cardIndex: 0, targetIndex: 0, cardsDone: 0, attempt: 1, retriesFixed: 0, timeouts: 0 };

afterEach(() => { delete globalThis.localStorage; });

describe("smart session memo (resume keeps the whole session's numbers)", () => {
  it("round-trips stats and the starting health for the same session", () => {
    const storage = memoryStorage();
    const healthBefore = { new: 33, learning: 0 };
    expect(saveSessionMemo("alice", "s1", { ...progress, stats, healthBefore, retriesFixed: 1 }, storage)).toBe(true);
    const memo = loadSessionMemo("alice", "s1", "", storage);
    expect(memo.stats).toEqual(stats);
    expect(memo.healthBefore).toEqual(healthBefore);
    expect(memo.retriesFixed).toBe(1);
  });

  it("never hands one session's numbers to another session", () => {
    const storage = memoryStorage();
    saveSessionMemo("alice", "s1", { ...progress, stats }, storage);
    expect(loadSessionMemo("alice", "s2", "", storage)).toBeNull();
  });

  it("clear drops the memo once the session completes", () => {
    const storage = memoryStorage();
    saveSessionMemo("alice", "s1", { ...progress, stats }, storage);
    clearSessionMemo("alice", "s1", "", storage);
    expect(loadSessionMemo("alice", "s1", "", storage)).toBeNull();
  });

  it("another account/session cannot overwrite or clear this session", () => {
    const storage = memoryStorage();
    saveSessionMemo("alice", "s1", { ...progress, stats }, storage);
    saveSessionMemo("bob", "s1", { ...progress, stats: { ...stats, correct: 4 } }, storage);
    saveSessionMemo("alice", "s2", { ...progress, stats }, storage);
    clearSessionMemo("alice", "s2", "", storage);
    expect(loadSessionMemo("alice", "s1", "", storage).stats.correct).toBe(1);
    expect(loadSessionMemo("bob", "s1", "", storage).stats.correct).toBe(4);
  });
  it("an older tab cannot overwrite or clear a rebuilt queue sharing the DB session id", () => {
    const storage = memoryStorage();
    saveSessionMemo("alice", "s1", { ...progress, stats, generation: "start-2" }, storage);
    saveSessionMemo("alice", "s1", { ...progress, stats: { ...stats, correct: 4 }, generation: "start-1" }, storage);
    clearSessionMemo("alice", "s1", "start-1", storage);
    expect(loadSessionMemo("alice", "s1", "start-2", storage).stats.correct).toBe(1);
  });

  it("rejects malformed stats and progress instead of poisoning the summary", () => {
    const storage = memoryStorage();
    for (const patch of [{ stats: { ...stats, correct: "3" } }, { attempt: 0 }, { targetIndex: 3 }]) {
      saveSessionMemo("alice", "s1", { ...progress, stats, ...patch }, storage);
      expect(loadSessionMemo("alice", "s1", "", storage)).toBeNull();
    }
  });

  it("checkpoints an answered target before the animation, without advancing the live board", () => {
    globalThis.localStorage = memoryStorage();
    const smart = { ...progress, sessionId: "s1", generation: "start-1", seed: 7,
      queue: [{ encoded: "card", targets: [{ uci: "e2e4" }, { uci: "d2d4" }] }] };
    saveSmartSession("alice", smart, stats, { advance: true });
    const memo = loadSessionMemo("alice", "s1", "start-1");
    expect(memo.targetIndex).toBe(1);
    expect(memo.stats).toEqual(stats);
    expect(smart.targetIndex).toBe(0);
    smart.targetIndex = 1;
    saveSmartSession("alice", smart, stats, { advance: true });
    expect(loadSessionMemo("alice", "s1", "start-1")).toMatchObject({ cardIndex: 1, targetIndex: 0, cardsDone: 1 });
  });

  it("ignores corrupt or blocked storage", () => {
    const storage = memoryStorage();
    storage.setItem("pf.trainSessionMemo.alice.s1.", "{not json");
    expect(loadSessionMemo("alice", "s1", "", storage)).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(saveSessionMemo("alice", "s1", { ...progress, stats }, blocked)).toBe(false);
    expect(loadSessionMemo("alice", "s1", "", blocked)).toBeNull();
    expect(() => clearSessionMemo("alice", "s1", "", blocked)).not.toThrow();
  });
});
