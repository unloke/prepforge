import { afterEach, describe, expect, it, vi } from "vitest";
import { mapTrainUiSession, shouldResetTrainStats } from "./train-resume.js";
import { clearSessionMemo, loadSessionMemo, saveSessionMemo } from "./train-session-memo.js";
import * as trainSessionMemo from "./train-session-memo.js";
import { readTrainingHistory } from './train-history.js';
import { smartResult } from "./train-result.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
function compile(marker, deps) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`not found: ${marker}`);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `let smartStartSeq = 0; return (${source.slice(start, end)});`)(...Object.values(deps));
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const stats = { skipped: 0, correct: 3, mistakes: 1, streak: 2, best: 2, history: [true, false, true, true], lastStreak: 0 };
const queue = [0, 1, 2].map((i) => ({ encoded: `card-${i}`, targets: [{ uci: "e2e4" }, { uci: "d2d4" }] }));
const memo = { stats, seed: 7, generation: "start-1", healthBefore: { new: 20 }, queue, cardIndex: 1, targetIndex: 1, attempt: 2,
  cardsDone: 1, retriesFixed: 1, timeouts: 1 };

function harness(overrides = {}) {
  const data = new Map();
  globalThis.localStorage = { get length() { return data.size; }, key: index => [...data.keys()][index] ?? null,
    getItem: (k) => data.get(k) || null,
    setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  const appState = { accountUserId: "alice", trainStats: { ...stats }, trainMode: "smart" };
  const payload = { mode: "smart", session_id: "session", seed: 7, session_generation: "start-1", card_index: 1, resumed: true, cards: queue,
    requeue_gap: 4, card_kinds: [{ key: "due", label: "Server label", title: "Server title" }],
    health: { new: 18 }, ...overrides };
  const present = vi.fn(async () => {});
  const phase = deferred();
  const deps = {
    countOf: (n, one) => `${n} ${n === 1 ? one : `${one}s`}`,
    appState, mapTrainUiSession, shouldResetTrainStats, saveSessionMemo, loadSessionMemo, clearSessionMemo, trainSessionMemo,
    loadTrainResume: async () => ({ mapTrainUiSession, shouldResetTrainStats }),
    currentOwnerId: () => appState.accountUserId,
    trainStatsReset: () => { appState.trainStats = mapTrainUiSession(payload).stats; },
    invalidateTrainPreview: vi.fn(), trainRowError: vi.fn(), smartResult,
    home: { showTrainResult: vi.fn((result) => { appState.trainResult = result; }) },
    setStatus: vi.fn(), setTrainBanner: vi.fn(), hardFlushBuild: async () => {}, flushTrainSync: async () => true,
    postJson: vi.fn(async () => payload), clearBlitzTimer: vi.fn(), blitzEnabled: () => true,
    pendingHandoffs: () => [], setBlitzBarVisible: vi.fn(), boards: {},
    document: { getElementById: () => ({ hidden: false, scrollIntoView() {} }) },
    renderSmartQueueStrip: async () => {}, renderTrainStats: async () => {}, setTrainSyncState: vi.fn(),
    loadPhaseCoach: () => phase.promise, syncWorkspaceUrl: vi.fn(),
    smartLocalPrompt: (smart) => smart.cardIndex < smart.queue.length
      ? { cardIndex: smart.cardIndex, targetIndex: smart.targetIndex } : null,
    presentSmartPrompt: present, finishSmartSession: vi.fn(async () => {}),
    refreshRepertoireHead: vi.fn(async () => {}), refreshDashboardRepertoires: vi.fn(async () => {}),
    refreshTrainSessionPreview: vi.fn(async () => {}),
    playSound: vi.fn(),
    reveal: (el) => { el.hidden = false; },
  };
  deps.syncTrainSessionControls = vi.fn();
  deps.celebrate = compile("function celebrate(", deps);
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
    expect(h.appState.smart.requeueGap).toBe(4);
    expect(h.appState.smart.cardKinds.due).toEqual(h.payload.card_kinds[0]);
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
  it("names each setup step before it waits", async () => {
    const h = harness();
    await h.start();
    const subtitles = h.deps.setTrainBanner.mock.calls.map((call) => call[2]);
    // No subtitle restates the title: the server step is "Choosing the cards…",
    // not "Building the queue on the server…" under "Building your queue…".
    const titles = h.deps.setTrainBanner.mock.calls.map((call) => call[1]);
    for (let i = 0; i < titles.length; i += 1) expect(subtitles[i]).not.toBe(titles[i]);
    expect(subtitles).toEqual(expect.arrayContaining([
      "Saving repertoire edits…",
      "Syncing your last session…",
      "Choosing the cards…",
      "Loading session tools…",
      "Opening your first card…",
    ]));
  });
  it("posts the repertoire Start was given, and keeps it as the Train link's repertoire", async () => {
    const h = harness({ mixed: false, repertoire_id: "r2" });
    await h.start({ repertoireId: "r2" });
    expect(h.deps.postJson).toHaveBeenCalledWith("/api/train/smart/start", {
      mixed: false, fresh: false, repertoire_id: "r2",
    });
    expect(h.appState.trainingRepertoireId).toBe("r2");
  });
  it("a mixed queue drills every active repertoire, so the Train link names none", async () => {
    const h = harness({ mixed: true, repertoire_id: "r1" });
    h.appState.trainingRepertoireId = "r1"; // left by a previous single-repertoire start
    await h.start();
    expect(h.deps.postJson).toHaveBeenCalledWith("/api/train/smart/start", { mixed: true, fresh: false });
    expect(h.appState.trainingRepertoireId).toBeNull();
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
  it("a new queue drops the last run's Result", async () => {
    const h = harness();
    h.appState.trainResult = { mode: "smart", title: "Queue complete" };
    await h.start();
    expect(h.appState.trainResult).toBeNull();
    expect(h.deps.invalidateTrainPreview).toHaveBeenCalled();
  });

  it("Finish shows the Result at once, then fills in what changed, without exclamation marks", async () => {
    const h = harness();
    const node = { style: {}, innerHTML: "", textContent: "", setAttribute: vi.fn(), hidden: false, className: "", appendChild() {}, remove() {}, scrollIntoView() {} };
    const fakeDoc = { getElementById: () => node, createElement: () => node };
    h.deps.celebrate = compile("function celebrate(", { ...h.deps, document: fakeDoc, window: { setTimeout: () => {} } });
    const after = { health: { new: 16, learning: 2 }, due_tomorrow: 2 };
    const finish = compile("async function finishSmartSession(", {
      ...h.deps, document: fakeDoc,
      boards: { train: { setEngineArrow: vi.fn(), setPosition: vi.fn() } },
      updateTrainTurnBadge: vi.fn(), localDateString: () => "2026-10-01", api: async () => after,
    });
    await h.start();
    h.appState.smart.blitz = false;
    await finish();
    const shown = h.deps.home.showTrainResult.mock.calls.map((call) => call[0]);
    expect(shown).toHaveLength(2);
    expect(shown[0].foot).toBe("");
    expect(shown[1].foot).toBe("2 reviews due tomorrow");
    for (const result of shown) expect(result.title).toBe("Queue complete");
    for (const result of shown) expect(JSON.stringify(result)).not.toContain("!");
    // The live session is released once the report owns the screen, and every
    // cached count of what is left to train is refreshed.
    expect(h.appState.smart).toBeNull();
    expect(h.deps.refreshRepertoireHead).toHaveBeenCalled();
    expect(h.deps.refreshDashboardRepertoires).toHaveBeenCalled();
  });

  it("a Result the player already left is not repainted when the summary lands", async () => {
    const h = harness();
    const late = deferred();
    const finish = compile("async function finishSmartSession(", {
      ...h.deps, document: { getElementById: () => ({ style: {}, textContent: "" }) },
      boards: { train: { setEngineArrow: vi.fn(), setPosition: vi.fn() } }, celebrate: vi.fn(),
      updateTrainTurnBadge: vi.fn(), localDateString: () => "2026-10-01", api: () => late.promise,
    });
    await h.start();
    const done = finish();
    await vi.waitFor(() => expect(h.deps.home.showTrainResult).toHaveBeenCalledTimes(1));
    h.appState.trainResult = null; // ‹ Train
    late.resolve({ due_tomorrow: 1 });
    await done;
    expect(h.deps.home.showTrainResult).toHaveBeenCalledTimes(1);
  });

  it("Finish clears only this owner/session's memo", async () => {
    const h = harness();
    await h.start();
    saveSessionMemo("bob", "session", memo);
    const finish = compile("async function finishSmartSession(", {
      ...h.deps, document: { getElementById: () => ({ style: {}, innerHTML: "", scrollIntoView() {} }) },
      boards: { train: { setEngineArrow: vi.fn(), setPosition: vi.fn() } },
      celebrate: vi.fn(), updateTrainTurnBadge: vi.fn(), localDateString: () => "2026-10-01", api: async () => null,
    });
    h.appState.smart.cardIndex = h.appState.smart.queue.length;
    h.appState.smart.cardsDone = 3;
    await finish();
    expect(readTrainingHistory('alice')).toHaveLength(1);
    expect(readTrainingHistory('bob')).toHaveLength(0);
    expect(loadSessionMemo("alice", "session", "start-1")).toBeNull();
    expect(loadSessionMemo("bob", "session", "start-1")).not.toBeNull();
  });
});
