import { afterEach, describe, expect, it, vi } from "vitest";
import { mapTrainUiSession, shouldResetTrainStats } from "./train-resume.js";
import { clearSessionMemo, loadSessionMemo, saveSessionMemo } from "./train-session-memo.js";
import * as trainSessionMemo from "./train-session-memo.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
function compile(marker, deps) {
  const start = source.indexOf(marker);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `let smartStartSeq = 0; return (${source.slice(start, end)});`)(...Object.values(deps));
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const stats = { correct: 3, mistakes: 1, streak: 2, best: 2, history: [true, false, true, true], lastStreak: 0 };
const queue = [0, 1, 2].map((i) => ({ encoded: `card-${i}`, targets: [{ uci: "e2e4" }, { uci: "d2d4" }] }));
const memo = { stats, seed: 7, generation: "start-1", healthBefore: { new: 20 }, queue, cardIndex: 1, targetIndex: 1, attempt: 2,
  cardsDone: 1, retriesFixed: 1, timeouts: 1 };

function harness(overrides = {}) {
  const data = new Map();
  globalThis.localStorage = { getItem: (k) => data.get(k) || null,
    setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  const appState = { accountUserId: "alice", trainStats: { ...stats }, trainMode: "smart" };
  const payload = { mode: "smart", session_id: "session", seed: 7, session_generation: "start-1", card_index: 1, resumed: true, cards: queue,
    health: { new: 18 }, ...overrides };
  const present = vi.fn(async () => {});
  const phase = deferred();
  const deps = {
    countOf: (n, one) => `${n} ${n === 1 ? one : `${one}s`}`,
    appState, mapTrainUiSession, shouldResetTrainStats, saveSessionMemo, loadSessionMemo, clearSessionMemo, trainSessionMemo,
    loadTrainResume: async () => ({ mapTrainUiSession, shouldResetTrainStats }),
    currentOwnerId: () => appState.accountUserId,
    trainStatsReset: () => { appState.trainStats = mapTrainUiSession(payload).stats; },
    setStatus: vi.fn(), setTrainBanner: vi.fn(), hardFlushBuild: async () => {}, flushTrainSync: async () => true,
    postJson: vi.fn(async () => payload), clearBlitzTimer: vi.fn(), blitzEnabled: () => true,
    pendingHandoffs: () => [], setBlitzBarVisible: vi.fn(), boards: {},
    document: { getElementById: () => ({ hidden: false }) }, setSmartPanelsHidden: vi.fn(),
    renderSmartQueueStrip: async () => {}, renderTrainStats: async () => {}, setTrainSyncState: vi.fn(),
    loadPhaseCoach: () => phase.promise, syncWorkspaceUrl: vi.fn(),
    smartLocalPrompt: (smart) => smart.cardIndex < smart.queue.length
      ? { cardIndex: smart.cardIndex, targetIndex: smart.targetIndex } : null,
    presentSmartPrompt: present, finishSmartSession: vi.fn(async () => {}),
  };
  deps.rememberSmartSession = compile("function rememberSmartSession(", deps);
  return { appState, deps, start: compile("async function startSmartTraining(", deps), present, phase, payload };
}
afterEach(() => { delete globalThis.localStorage; });

describe("Smart memo integration at Start", () => {
  it("a resumed session without a memo cannot inherit another session's counters", async () => {
    const h = harness();
    await h.start();
    expect(h.appState.trainStats.correct).toBe(0);
    expect(h.appState.trainStats.history).toEqual([]);
  });
  it("restores the current target and retry with the saved counts and starting health", async () => {
    const h = harness();
    saveSessionMemo("alice", "session", memo);
    await h.start();
    expect(h.appState.trainStats).toEqual(stats);
    expect(h.appState.smart.healthBefore).toEqual({ new: 20 });
    expect(h.present).toHaveBeenCalledWith({ cardIndex: 1, targetIndex: 1 }, { attempt: 2 });
    expect(h.appState.smart.timeouts).toBe(1);
  });
  it.each([{ resumed: false, card_index: 0 }, { resumed: true, fresh: true }])
  ("never restores for a non-resumed/fresh start ($resumed/$fresh)", async ({ fresh, ...payload }) => {
    const h = harness(payload);
    saveSessionMemo("alice", "session", memo);
    await h.start({ fresh });
    expect(h.appState.trainStats.correct).toBe(0);
    expect(h.appState.smart.targetIndex).toBe(0);
  });
  it("does not restore another account's memo even for the same session id", async () => {
    const h = harness();
    saveSessionMemo("bob", "session", memo);
    await h.start();
    expect(h.appState.trainStats.correct).toBe(0);
  });
  it("rejects a memo behind the server cursor (another tab advanced)", async () => {
    const h = harness({ card_index: 2 });
    saveSessionMemo("alice", "session", memo);
    await h.start();
    expect(h.appState.trainStats.correct).toBe(0);
    expect(h.appState.smart.cardIndex).toBe(2);
  });
  it("rejects an old queue generation even when the backend reused its id and cards", async () => {
    const h = harness({ session_generation: "start-2" });
    saveSessionMemo("alice", "session", memo);
    await h.start();
    expect(h.appState.trainStats.correct).toBe(0);
  });
  it("restores a genuine resume still inside the first card", async () => {
    const h = harness({ card_index: 0 });
    saveSessionMemo("alice", "session", { ...memo, cardIndex: 0 });
    await h.start();
    expect(h.present).toHaveBeenCalledWith({ cardIndex: 0, targetIndex: 1 }, { attempt: 2 });
    expect(h.appState.trainStats).toEqual(stats);
  });
  it("a late phase-coach load cannot attach the old queue to a replacement session", async () => {
    const h = harness();
    await h.start();
    h.appState.smart = { sessionId: "replacement" };
    h.phase.resolve({ clusterQueueByPhase: () => "old queue" });
    await Promise.resolve();
    expect(h.appState.smart.phaseCluster).toBeUndefined();
  });
  it("uses the fresh server target data while restoring the memo's cursor", async () => {
    const updated = queue.map((card) => ({ ...card, targets: [{ uci: "g1f3" }, { uci: "f1c4" }] }));
    const h = harness({ cards: updated });
    saveSessionMemo("alice", "session", memo);
    await h.start();
    expect(h.appState.smart.queue[1].targets[1].uci).toBe("f1c4");
  });
  it("an older Start response cannot replace a newer queue or its memo", async () => {
    const h = harness();
    const old = deferred();
    const fresh = deferred();
    h.deps.postJson.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = h.start();
    await vi.waitFor(() => expect(h.deps.postJson).toHaveBeenCalledTimes(1));
    const second = h.start({ fresh: true });
    await vi.waitFor(() => expect(h.deps.postJson).toHaveBeenCalledTimes(2));
    fresh.resolve({ ...h.payload, session_generation: "start-2", resumed: false, card_index: 0 });
    await second;
    old.resolve(h.payload);
    await first;
    expect(h.appState.smart.generation).toBe("start-2");
    expect(loadSessionMemo("alice", "session", "start-2").generation).toBe("start-2");
  });
  it.each(["owner", "mode"])("ignores Start if the %s changed while the request was pending", async (change) => {
    const h = harness();
    const pending = deferred();
    h.deps.postJson.mockReturnValueOnce(pending.promise);
    const start = h.start();
    await vi.waitFor(() => expect(h.deps.postJson).toHaveBeenCalled());
    if (change === "owner") h.appState.accountUserId = "bob";
    else h.appState.trainMode = "all_lines";
    pending.resolve(h.payload);
    await start;
    expect(h.present).not.toHaveBeenCalled();
    expect(loadSessionMemo("alice", "session", "start-1")).toBeNull();
  });
  it("Finish clears only this owner/session's memo", async () => {
    const h = harness();
    await h.start();
    saveSessionMemo("bob", "session", memo);
    const finish = compile("async function finishSmartSession(", {
      ...h.deps, document: { getElementById: () => ({ style: {}, innerHTML: "" }) },
      boards: { train: { setEngineArrow: vi.fn(), setPosition: vi.fn() } },
      syncTrainSessionControls: vi.fn(), invalidateTrainSessionPreview: vi.fn(), celebrate: vi.fn(),
      localDateString: () => "2026-10-01", api: async () => null, renderSmartSummary: async () => {},
    });
    await finish();
    expect(loadSessionMemo("alice", "session", "start-1")).toBeNull();
    expect(loadSessionMemo("bob", "session", "start-1")).not.toBeNull();
  });
});
