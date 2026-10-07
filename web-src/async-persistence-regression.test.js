import { html } from "./html.js";
import { readFileSync } from "node:fs";
import { createSyncQueue } from "./sync-queue.js";
import { flushGroups, groupAttempts, ungroupAttempts } from "./sync-queue.js";
import { createBookActions } from "./analyze-book.js";
import { createSettingsActions } from "./settings-actions.js";
import { classifySyncError } from "./sync-errors.js";
import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
const source = appSource();
function compile(marker, deps, prelude = "", code = source) {
  deps = { html, ...deps };
  const start = code.indexOf(marker);
  const end = code.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `${prelude}; return (${code.slice(start, end)});`)(...Object.values(deps));
}
function queueFlush(marker, deps) {
  const train = marker.includes("Train"), app = deps.appState;
  const buildState = {
    get timer() { return app.buildFlushTimer; }, set timer(v) { app.buildFlushTimer = v; },
    get flushing() { return app.buildFlushing; }, set flushing(v) { app.buildFlushing = v; },
    get retry() { return app.buildSyncRetry; }, set retry(v) { app.buildSyncRetry = v; },
  };
  const queue = createSyncQueue({ key: train ? "train" : "build", tabId: "test",
    state: () => train ? app.trainSync : buildState, owner: deps.currentOwnerId,
    generation: () => app.ownerGeneration, idleMs: train ? 4000 : 2000,
    hasWork: () => train ? app.trainSync.pending.length || app.trainSync.dirty
      : app.build && (app.buildPending.length || app.buildPendingDeletes.length),
    persist: () => deps.persistOutbox(), flush: (checkpoint, isCurrent) => compile(marker, deps)(checkpoint, isCurrent),
  });
  deps[train ? "trainQueue" : "buildQueue"] = queue;
  return queue.flush;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("opening a repertoire retains and reapplies its durable pending deletes", async () => {
  const deletion = { id: "B-node", repertoire_id: "B" };
  const appState = { build: { repertoire_id: "A" }, buildPendingDeletes: [deletion], buildPending: [], buildIdMap: {} };
  const reapplyPendingBuildDeletes = vi.fn(() => {
    expect(appState.buildPendingDeletes).toEqual([deletion]);
  });
  const run = compile("async function hydrateBuild(", {
    appState, coverageView: { sync: vi.fn() }, clearTimeout: vi.fn(), boards: {}, invalidateBook: vi.fn(), renderBuildRepHeader: vi.fn(),
    selectBuildNode: vi.fn(), reapplyPendingBuildNodes: vi.fn(), reapplyPendingBuildDeletes,
    buildOpMatchesRepertoire: (op, id) => op.repertoire_id === id,
    renderBuildSync: vi.fn(), syncWorkspaceUrl: vi.fn(), hasPendingBuildOpsFor: () => true, setBuildSync: vi.fn(), scheduleBuildFlush: vi.fn(),
  });
  await run({ repertoire_id: "B", nodes: [{ id: "B-root" }] });
  expect(appState.buildPendingDeletes).toEqual([deletion]);
  expect(reapplyPendingBuildDeletes).toHaveBeenCalled();
});


it("an invalidated book load cannot publish or clear its replacement load", async () => {
  const first = deferred(), second = deferred();
  const bookState = { loaded: false, loading: null, reps: [], generation: 0 };
  const deps = { bookState, currentOwnerId: () => "owner", appState: { pendingRepDeletes: new Set() }, api: vi.fn()
    .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) };
  const actions = createBookActions(deps);
  const load = compile("async function ensureBookLoaded(", { ...deps, loadBookActions: async () => actions });
  const invalidate = compile("function invalidateBook(", deps);
  const old = load(); await vi.waitFor(() => expect(deps.api).toHaveBeenCalledTimes(1));
  invalidate(); const latest = load();
  await vi.waitFor(() => expect(deps.api).toHaveBeenCalledTimes(2));
  const replacement = bookState.loading;
  first.resolve({ repertoires: [] }); await old;
  expect(bookState.loaded).toBe(false);
  expect(bookState.loading).toBe(replacement);
  second.resolve({ repertoires: [] }); await latest;
  expect(bookState.loaded).toBe(true);
});

it("team detail B stays visible after slow A responds", async () => {
  const first = deferred(), second = deferred();
  const elements = new Map();
  const document = { getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", querySelectorAll: () => [] });
    return elements.get(id);
  } };
  const appState = { accountUserId: "owner" };
  const deps = { appState, document, currentOwnerId: () => "owner", renderTeamsList: vi.fn(),
    api: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    teamRoleLabel: (r) => r, teamsView: null,
    renderTeamSharedRepertoires: vi.fn() };
  const open = compile("async function openTeamDetail(", deps, "let teamDetailSeq = 0");
  const a = open("A"), b = open("B");
  second.resolve({ name: "B", role: "member", members: [] }); await b;
  first.resolve({ name: "A", role: "owner", members: [] }); await a;
  expect(elements.get("team-detail-name").textContent).toBe("B");
  expect(deps.renderTeamSharedRepertoires).toHaveBeenCalledTimes(1);
});

it("settings saves serialize patches and only publish the latest state", async () => {
  const first = deferred(), second = deferred();
  const appState = {};
  const applySettingsPayload = vi.fn((p) => { appState.settings = p; });
  const api = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const deps = { appState, currentOwnerId: () => "owner", api,
    applySettingsPayload, setStatusError: vi.fn(), explorerDrawerOpen: () => false };
  const actions = createSettingsActions(deps);
  const save = compile("async function saveSettings(", { ...deps, loadSettingsActions: async () => actions });
  const a = save({ maia_rating: 1500 }), b = save({ maia_rating: 2000 });
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  first.resolve({ maia_rating: 1500 }); await a;
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  second.resolve({ maia_rating: 2000 }); await b;
  expect(appState.settings.maia_rating).toBe(2000);
  expect(applySettingsPayload).toHaveBeenCalledTimes(1);
});


it("a legacy Train start cannot overwrite a newer session", async () => {
  const first = deferred(), second = deferred();
  const appState = { signedIn: true, trainMode: "all_lines" };
  const deps = { appState, currentOwnerId: () => "owner", selectedTrainRepertoireId: () => "r",
    clearBlitzTimer: vi.fn(), setBlitzBarVisible: vi.fn(), setSmartPanelsHidden: vi.fn(),
    setStatus: vi.fn(), hardFlushBuild: async () => {}, setStatusError: vi.fn(),
    loadTrainResume: async () => ({ mapTrainUiSession: (p) => p, shouldResetTrainStats: () => false }),
    postJson: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    boards: {}, document: { getElementById: () => ({}) }, renderTrainStats: vi.fn(),
    renderTraining: vi.fn(), syncWorkspaceUrl: vi.fn(), requireSignIn: vi.fn() };
  const run = compile("async function startTraining(", deps, "let smartStartSeq = 0");
  const a = run("all_lines"); await vi.waitFor(() => expect(deps.postJson).toHaveBeenCalledTimes(1));
  const b = run("all_lines"); await vi.waitFor(() => expect(deps.postJson).toHaveBeenCalledTimes(2));
  second.resolve({ session_id: "new", prompt: {}, lines: [] }); await b;
  first.resolve({ session_id: "old", prompt: {}, lines: [] }); await a;
  expect(appState.training.session_id).toBe("new");
  expect(deps.renderTraining).toHaveBeenCalledTimes(1);
});


it("Scout bulk counts only confirmed complete lines and continues after failures", async () => {
  const scoutSource = readFileSync(new URL("./views/scout.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // Private view functions are indented inside createScoutView.
  const code = scoutSource.replace(/^  /gm, "");
  const jobToast = { isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), completeJob: vi.fn() };
  const write = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("node");
  const run = compile("async function scoutPrepareAll(", {
    scoutLineKey: (ucis) => ucis.join(" "), setStatus: vi.fn(), jobToast,
    scoutPickRepertoire: async () => "r", scoutWriteLineToRep: write,
  }, "", code);
  await run(["a", "b", "c"].map((uci) => ({ ucis: [uci], sans: [uci] })), "white");
  expect(write).toHaveBeenCalledTimes(3);
  expect(jobToast.completeJob).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("1 line") }));
  expect(jobToast.completeJob.mock.calls[0][0].message).toContain("2 failed");
});

it("the application wires Scout's handoff recorder", async () => {
  const rememberHandoff = vi.fn();
  const createScoutView = vi.fn((deps) => { deps.rememberHandoff?.({ source: "scout" }); return {}; });
  const noop = () => {};
  const deps = Object.fromEntries(["escapeHtml", "setStatus", "switchView", "api", "showInputModal",
    "createRepertoirePrompt", "editRepertoire", "boardAfterMove", "buildProvisionalNode", "hardFlushBuild",
    "selectBuildNode", "resolveBuildId", "setBuildSync", "jobToast", "parseFenBoard", "pieceSvg",
    "startLichessOAuth", "loadPgnIntoAnalyze", "effectiveMaiaRating", "maiaAnalysisEnabled",
    "scoutPickedUsernames", "requireSignIn", "effectiveStockfishDepth"].map((key) => [key, noop]));
  const run = compile("async function ensureScoutView(", { ...deps, rememberHandoff,
    preloadScoutView: async () => ({ createScoutView }) }, "let scoutView = null");
  await run();
  expect(rememberHandoff).toHaveBeenCalledWith({ source: "scout" });
});


function buildFlushHarness() {
  const op = { tempId: "tmp-a", parentRef: "root", uci: "e2e4", repertoire_id: "r" };
  const appState = { build: { repertoire_id: "r", revision: 1 }, buildPending: [op], buildPendingDeletes: [],
    buildSyncRetry: 0, buildIdMap: {}, buildNodeById: new Map([["tmp-a", {}]]), buildCurrentNodeId: "tmp-a" };
  const deps = { appState, currentOwnerId: () => "owner", captureBuildContext: () => () => true,
    resolveBuildId: (id) => id, acquireFlushLock: () => true, OUTBOX_TAB_ID: "tab", clearTimeout: vi.fn(), setBuildSync: vi.fn(),
    buildOpMatchesRepertoire: (op, id) => op.repertoire_id === id, setStatus: vi.fn(),
    postJson: vi.fn(async () => ({ repertoire_id: "r", revision: 2, id_map: { "tmp-a": "real" }, nodes: [{ id: "real" }] })),
    queuedBuildRevision: () => 1, buildAddId: (op) => op.tempId, buildDeleteId: (op) => op.id,
    persistOutbox: vi.fn(), hydrateBuild: vi.fn(async () => { throw new Error("render failed"); }),
    setStatusError: vi.fn(), hasPendingBuildOpsFor: () => false, clearOutboxWhenQuiescent: vi.fn(),
    releaseFlushLock: vi.fn(), classifySyncError: () => ({ kind: "network" }), describeSyncError: () => "error",
    setTimeout: vi.fn(), BUILD_FLUSH_MAX_BACKOFF_MS: 30000, scheduleBuildFlush: vi.fn(),
    reapplyPendingBuildNodes: vi.fn(), reapplyPendingBuildDeletes: vi.fn(),
  };
  return { op, appState, deps, run: queueFlush("function flushBuildMoves(", deps) };
}

it("Build render failure after commit does not requeue confirmed adds", async () => {
  const { run, appState, deps } = buildFlushHarness();
  expect(await run()).toBe(true);
  expect(appState.buildPending).toEqual([]);
  expect(appState.buildIdMap["tmp-a"]).toBe("real");
  expect(deps.persistOutbox).toHaveBeenCalledWith(expect.objectContaining({ build: ["tmp-a"] }));
  expect(deps.postJson).toHaveBeenCalledTimes(1);
});


function trainFlushHarness() {
  let owner = "alice";
  const response = deferred();
  const sync = { pending: [{ session_id: "s", session_generation: "old", node_id: "n", correct: true, attempt_uuid: "u" }], dirty: true, retry: 0 };
  const appState = { trainSync: sync, smart: { sessionId: "s", generation: "old", stateVersion: 3, cardIndex: 1, queue: [{ encoded: "old-card" }] } };
  const deps = { appState, currentOwnerId: () => owner, flushGroups, groupAttempts, ungroupAttempts,
    setTrainSyncState: vi.fn(), clearTimeout: vi.fn(), postJson: vi.fn(() => response.promise),
    localDateString: () => "2026-10-02", persistOutbox: vi.fn(), trainAttemptId: (a) => a.attempt_uuid,
    classifySyncError, setStatus: vi.fn(), setTimeout: vi.fn(), TRAIN_SYNC_MAX_BACKOFF_MS: 30000,
    clearOutboxWhenQuiescent: vi.fn(), scheduleTrainSync: vi.fn() };
  return { run: queueFlush("function flushTrainSync(", deps), appState, deps, response, setOwner: (next) => { owner = next; } };
}

it("a late Smart sync failure keeps the old generation and cannot dirty its rebuilt session", async () => {
  const h = trainFlushHarness();
  const pending = h.run();
  await Promise.resolve();
  expect(h.deps.postJson.mock.calls[0][1]).toMatchObject({ session_generation: "old", card_index: 1, queue: ["old-card"] });
  h.appState.smart = { sessionId: "s", generation: "new", queue: [], cardIndex: 0 };
  h.response.reject(Object.assign(new Error("offline"), { status: 503 }));
  expect(await pending).toBe(false);
  expect(h.appState.trainSync.pending[0].session_generation).toBe("old");
  expect(h.appState.trainSync.dirty).toBe(false);
});

it("Smart sync sends the captured version and advances it only after accepting state", async () => {
  const h = trainFlushHarness();
  const pending = h.run();
  await Promise.resolve();
  expect(h.deps.postJson.mock.calls[0][1].state_version).toBe(3);
  h.response.resolve({ state_applied: true, state_version: 5 });
  await pending;
  expect(h.appState.smart.stateVersion).toBe(5);
});

it("Smart sync settles attempts but does not adopt a conflicting state's version", async () => {
  const h = trainFlushHarness();
  const pending = h.run();
  h.response.resolve({ synced: 1, state_applied: false, state_version: 7 });
  await pending;
  expect(h.appState.smart.stateVersion).toBe(3);
  expect(h.appState.trainSync.pending).toEqual([]);
  expect(h.deps.setStatus).toHaveBeenCalledWith(expect.stringContaining("Resume"), { severity: "error" });
});

it("changing owners during the durable checkpoint releases the old flush without sending", async () => {
  const h = trainFlushHarness();
  const checkpoint = deferred();
  h.deps.persistOutbox.mockImplementationOnce(() => checkpoint.promise);
  const pending = h.run();
  const old = h.appState.trainSync;
  h.setOwner("bob");
  h.appState.trainSync = { pending: [], dirty: false };
  checkpoint.resolve(true);
  expect(await pending).toBe(false);
  expect(old.flushing).toBeNull();
  expect(h.deps.postJson).not.toHaveBeenCalled();
});

it("a Train sync response after changing owners cannot settle the new owner's outbox or streak", async () => {
  const h = trainFlushHarness();
  const pending = h.run();
  await Promise.resolve();
  expect(h.deps.persistOutbox).toHaveBeenCalledTimes(1);
  h.deps.persistOutbox.mockClear();
  h.setOwner("bob");
  const bob = { pending: [{ attempt_uuid: "bob" }], dirty: true };
  h.appState.trainSync = bob;
  h.response.resolve({ day_streak: 99 });
  expect(await pending).toBe(false);
  expect(h.appState.trainSync).toBe(bob);
  expect(h.appState.dayStreak).toBeUndefined();
  expect(h.deps.persistOutbox).not.toHaveBeenCalled();
});


it("a late Generate save response cannot hydrate the repertoire the user left", async () => {
  const start = source.indexOf('    const payload = await postJson(', source.indexOf('    jobToast.lockJob("saving'));
  const end = source.indexOf('    const summary = payload.summary', start);
  const response = deferred();
  let current = true;
  const hydrateBuild = vi.fn();
  const run = new Function("postJson", "hydrateBuild", "isCurrent", "controller",
    "generatedRepertoireId", "generatedBaseRevision", "nodeId", "plan",
    `return (async () => { ${source.slice(start, end)} })();`);
  const pending = run(() => response.promise, hydrateBuild, () => current,
    new AbortController(), "A", 1, "node", {});
  current = false;
  response.resolve({ repertoire_id: "A", nodes: [] }); await pending;
  expect(hydrateBuild).not.toHaveBeenCalled();
});


it("a lost Build response retains deleted in-flight adds until their IDs can be recovered", async () => {
  const h = buildFlushHarness();
  const response = deferred();
  h.deps.postJson.mockImplementationOnce(() => response.promise);
  const pending = h.run();
  h.appState.buildNodeById.delete("tmp-a");
  h.appState.buildPendingDeletes.push({ id: "tmp-a", repertoire_id: "r", base_revision: 1 });
  response.reject(new Error("response lost"));
  expect(await pending).toBe(false);
  expect(h.appState.buildPending).toEqual([h.op]);
  expect(h.appState.buildPendingDeletes).toHaveLength(1);
  h.deps.hydrateBuild.mockResolvedValue(undefined);
  h.deps.hasPendingBuildOpsFor = () => true;
  // Use the real ID lookup; queued deletion must wait while the add retries.
  h.deps.resolveBuildId = (entry) => {
    const id = entry?.id || entry;
    return h.appState.buildIdMap[id] || id;
  };
  const retry = queueFlush("function flushBuildMoves(", h.deps);
  expect(await retry()).toBe(true);
  expect(h.deps.postJson.mock.calls[1][0]).toBe("/api/build/add-moves");
  expect(h.deps.postJson.mock.calls[1][1].moves[0].tempId).toBe("tmp-a");
  expect(h.appState.buildPendingDeletes).toHaveLength(1);
  expect(h.deps.resolveBuildId(h.appState.buildPendingDeletes[0])).toBe("real");
});


it("an older Settings GET cannot repaint state after a newer save", async () => {
  const get = deferred(), post = deferred();
  const appState = { signedIn: true };
  const view = { renderSettings: vi.fn() };
  const deps = { appState, currentOwnerId: () => "owner", ensureSettingsView: async () => view,
    api: vi.fn().mockReturnValueOnce(get.promise).mockReturnValueOnce(post.promise),
    applySettingsPayload: (p) => { appState.settings = p; },
    applyServerEngineGating: vi.fn(), setStatusError: vi.fn(), explorerDrawerOpen: () => false };
  const actions = createSettingsActions(deps);
  const load = actions.loadSettingsOnce();
  await vi.waitFor(() => expect(deps.api).toHaveBeenCalledTimes(1));
  const save = actions.saveSettings({ maia_rating: 2000 });
  await vi.waitFor(() => expect(deps.api).toHaveBeenCalledTimes(2));
  post.resolve({ maia_rating: 2000 }); await save;
  get.resolve({ maia_rating: 1500 }); await load;
  expect(appState.settings.maia_rating).toBe(2000);
  expect(view.renderSettings).not.toHaveBeenCalled();
});
