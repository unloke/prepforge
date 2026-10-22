import { afterEach, describe, expect, it, vi } from "vitest";
import { queueRepertoireForStart, rememberFinishedQueueScope, startNotice } from "./train-start.js";
import { mapTrainUiSession, shouldResetTrainStats } from "./train-resume.js";
import { clearSessionMemo, loadSessionMemo, saveSessionMemo } from "./train-session-memo.js";
import * as trainSessionMemo from "./train-session-memo.js";
import { readTrainingHistory } from './train-history.js';
import { smartSessionOutcomeText } from "./train-outcome.js";
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
    invalidateTrainSessionPreview: () => {},
    queueRepertoireForStart, startNotice,
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
  deps.setSmartPanelsHidden = compile("function setSmartPanelsHidden(", deps);
  deps.renderSmartSummaryStats = vi.fn();
  deps.paintTrainStartDisabled = vi.fn();
  deps.syncTrainSessionControls = vi.fn();
  deps.showSmartSummary = compile("function showSmartSummary(", deps);
  deps.smartSessionOutcomeText = smartSessionOutcomeText;
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
  it("a new queue clears the last session's result cells", async () => {
    const h = harness();
    const cells = { innerHTML: "old cells" };
    const delta = { innerHTML: "old delta" };
    const foot = { textContent: "old foot" };
    const els = { "train-summary-stats": cells, "train-summary-delta": delta, "train-summary-foot": foot };
    // The clear lives in setSmartPanelsHidden; call it as Start does.
    const dom = { getElementById: (id) => els[id] || null };
    const clear = compile("function setSmartPanelsHidden(", { ...h.deps, document: dom });
    clear();
    expect(String(cells.innerHTML)).toBe("");
    expect(String(delta.innerHTML)).toBe("");
    expect(foot.textContent).toBe("");
  });

  it("the finished session speaks without exclamation marks", async () => {
    const h = harness();
    const setAttribute = vi.fn();
    const node = { style: {}, innerHTML: "", textContent: "", setAttribute, hidden: false, className: "", appendChild() {}, remove() {}, scrollIntoView() {} };
    const el = () => node;
    const fakeDoc = { getElementById: el, createElement: () => node };
    h.deps.celebrate = compile("function celebrate(", { ...h.deps, document: fakeDoc, window: { setTimeout: () => {} } });
    const finish = compile("async function finishSmartSession(", {
      ...h.deps, document: fakeDoc,
      boards: { train: { setEngineArrow: vi.fn(), setPosition: vi.fn() } },
      syncTrainSessionControls: vi.fn(), invalidateTrainSessionPreview: vi.fn(), updateTrainTurnBadge: vi.fn(),
      localDateString: () => "2026-10-01", api: async () => null, renderSmartSummary: async () => {},
      rememberFinishedQueueScope,
    });
    await h.start();
    h.appState.smart.blitz = false;
    await finish();
    // The session moved spaced-repetition state: the "to train" counts are stale.
    // The live session is released once the report owns the screen, so the setup
    // screen and Start describe the queue as it now stands.
    expect(h.appState.smart).toBeNull();
    await vi.waitFor(() => expect(h.deps.refreshRepertoireHead).toHaveBeenCalled());
    expect(h.deps.refreshDashboardRepertoires).toHaveBeenCalled();
    expect(h.deps.paintTrainStartDisabled).toHaveBeenCalled();
    // The report is on screen before the flush and the summary fetch answer.
    expect(h.deps.renderSmartSummaryStats).toHaveBeenCalled();
    expect(h.deps.renderSmartSummaryStats.mock.calls[0][0].sessionId).toBe("session");
    const titles = h.deps.setTrainBanner.mock.calls.map((call) => call[1]);
    expect(titles.filter((title) => /session complete/i.test(title))).toEqual(["Session complete"]);
    for (const title of titles) expect(title).not.toContain("!");
    // The end label names the position in a few words: the phone's thumb bar
    // ellipsized "Final position of the last card". The fixture cards carry no
    // fen_after, so the label is cleared here.
    expect(String(node.textContent)).toBe("");
  });

  it("Finish clears only this owner/session's memo", async () => {
    const h = harness();
    await h.start();
    saveSessionMemo("bob", "session", memo);
    const finish = compile("async function finishSmartSession(", {
      ...h.deps, document: { getElementById: () => ({ style: {}, innerHTML: "", scrollIntoView() {} }) },
      boards: { train: { setEngineArrow: vi.fn(), setPosition: vi.fn() } },
      syncTrainSessionControls: vi.fn(), invalidateTrainSessionPreview: vi.fn(), celebrate: vi.fn(), updateTrainTurnBadge: vi.fn(),
      localDateString: () => "2026-10-01", api: async () => null, renderSmartSummary: async () => {},
      smartSessionOutcomeText: () => "", rememberFinishedQueueScope,
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
