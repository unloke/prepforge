import { html } from "./html.js";
import { readFileSync } from "node:fs";
import { countOf } from "./plural.js";
import { createSyncQueue } from "./sync-queue.js";
import { flushGroups, groupAttempts, ungroupAttempts } from "./train-outbox.js";
import { createBookActions } from "./analyze-book.js";
import { indexBuildNodes } from "./build-tree.js";
import { createSettingsActions } from "./settings-actions.js";
import { classifySyncError } from "./sync-errors.js";
import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { memberRowsSkeleton, sharedRepRowsSkeleton } from "./views/team-skeleton.js";
import { asSlices } from "./state/as-slices.fixture.js";
const source = appSource();
// cancelStaleTrainStart is one line of app.js.
const cancelStaleTrainStartSource = () => source.slice(source.indexOf("function cancelStaleTrainStart("), source.indexOf("\n", source.indexOf("function cancelStaleTrainStart(")) + 1);
function compile(marker, deps, prelude = "", code = source) {
  deps = { html, ...deps };
  const start = code.indexOf(marker);
  const end = code.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `${prelude}; return (${code.slice(start, end)});`)(...Object.values(deps));
}
function queueFlush(marker, deps) {
  const train = marker.includes("Train"), build = deps.buildState, trainState = deps.trainState;
  const buildQueueState = {
    get timer() { return build.buildFlushTimer; }, set timer(v) { build.buildFlushTimer = v; },
    get flushing() { return build.buildFlushing; }, set flushing(v) { build.buildFlushing = v; },
    get retry() { return build.buildSyncRetry; }, set retry(v) { build.buildSyncRetry = v; },
  };
  const queue = createSyncQueue({ key: train ? "train" : "build", tabId: "test",
    state: () => train ? trainState.trainSync : buildQueueState, owner: deps.currentOwnerId,
    generation: () => deps.appState.ownerGeneration, idleMs: train ? 4000 : 2000,
    hasWork: () => train ? trainState.trainSync.pending.length || trainState.trainSync.dirty
      : build.buildPending.length || build.buildPendingDeletes.length,
    persist: () => deps.persistOutbox(), flush: (checkpoint, isCurrent) => compile(marker, deps)(checkpoint, isCurrent),
  });
  deps[train ? "trainQueue" : "buildQueue"] = queue;
  // Each adapter files settled ids under its own slice; the tests watch one mock.
  deps[train ? "persistTrainOutbox" : "persistBuildOutbox"] = (...args) => deps.persistOutbox(...args);
  if (!train) deps.postBuildWrite = (...args) => deps.postJson(...args);
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
    ...asSlices(appState), coverageView: { sync: vi.fn() }, clearTimeout: vi.fn(), boards: {}, announceRepertoireChanged: vi.fn(), renderBuildRepHeader: vi.fn(),
    selectBuildNode: vi.fn(), reapplyPendingBuildNodes: vi.fn(), reapplyPendingBuildDeletes, indexBuildNodes,
    resolveBuildId: id => id,
    buildOpMatchesRepertoire: (op, id) => op.repertoire_id === id,
    renderBuildSync: vi.fn(), syncWorkspaceUrl: vi.fn(), hasPendingBuildOpsFor: () => true, setBuildSync: vi.fn(), scheduleBuildFlush: vi.fn(),
  });
  await run({ repertoire_id: "B", revision: 5, nodes: [{ id: "B-root" }] });
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
  const deps = { ...asSlices(appState), document, currentOwnerId: () => "owner", renderTeamsList: vi.fn(),
    api: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    teamRoleLabel: (r) => r, teamsView: null,
    renderTeamSharedRepertoires: vi.fn(), memberRowsSkeleton, sharedRepRowsSkeleton,
    formatDay: () => "", renderTeamInviteFooter: () => {}, enterRows: () => {}, syncTeamActions: () => {} };
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
  const deps = { ...asSlices(appState), currentOwnerId: () => "owner", api,
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
  const appState = { signedIn: true, trainMode: "all_lines", trainingRepertoireId: "r" };
  const deps = { ...asSlices(appState), currentOwnerId: () => "owner", trainRowError: vi.fn(), syncTrainSessionControls: vi.fn(),
    setTrainBanner: vi.fn(), trainStatsReset: vi.fn(), isNothingToTrainError: () => false,
    clearBlitzTimer: vi.fn(), setBlitzBarVisible: vi.fn(), setSmartPanelsHidden: vi.fn(),
    setStatus: vi.fn(), hardFlushBuild: async () => {}, setStatusError: vi.fn(),
    restoreRehearsal: vi.fn(() => null),
    postJson: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    boards: {}, document: { getElementById: () => ({}) }, renderTrainStats: vi.fn(),
    renderTraining: vi.fn(), syncWorkspaceUrl: vi.fn(), requireSignIn: vi.fn(), reveal: (el) => { el.hidden = false; } };
  const run = compile("async function startTraining(", deps, "let smartStartSeq = 0; " + cancelStaleTrainStartSource());
  const a = run("all_lines"); await vi.waitFor(() => expect(deps.postJson).toHaveBeenCalledTimes(1));
  const b = run("all_lines"); await vi.waitFor(() => expect(deps.postJson).toHaveBeenCalledTimes(2));
  second.resolve({ session_id: "new", prompt: {}, lines: [] }); await b;
  first.resolve({ session_id: "old", prompt: {}, lines: [] }); await a;
  expect(appState.training.session_id).toBe("new");
  expect(deps.renderTraining).toHaveBeenCalledTimes(1);
});

function rehearsalHarness(flush) {
  const appState = { signedIn: true, trainMode: "all_lines", trainingRepertoireId: "r", trainStarting: true };
  const deps = { ...asSlices(appState), currentOwnerId: () => "owner", trainRowError: vi.fn(), syncTrainSessionControls: vi.fn(),
    setTrainBanner: vi.fn(), trainStatsReset: vi.fn(), isNothingToTrainError: () => false,
    clearBlitzTimer: vi.fn(), setBlitzBarVisible: vi.fn(), setSmartPanelsHidden: vi.fn(),
    setStatus: vi.fn(), hardFlushBuild: vi.fn(() => flush.promise), setStatusError: vi.fn(),
    restoreRehearsal: vi.fn(() => null), postJson: vi.fn(),
    boards: {}, document: { getElementById: () => ({}) }, renderTrainStats: vi.fn(),
    renderTraining: vi.fn(), syncWorkspaceUrl: vi.fn(), requireSignIn: vi.fn(), reveal: (el) => { el.hidden = false; } };
  const run = compile("async function startTraining(", deps, "let smartStartSeq = 0; " + cancelStaleTrainStartSource());
  return { ...asSlices(appState), appState, deps, run };
}

it("an invalidated rehearsal start cleans up when its Build flush resolves", async () => {
  const flush = deferred();
  const { appState, deps, run } = rehearsalHarness(flush);
  const token = {}; let active = true;
  appState.trainStartToken = token;
  const attempt = run("all_lines", { entryToken: token, isCurrent: () => active });
  await vi.waitFor(() => expect(deps.hardFlushBuild).toHaveBeenCalled());
  active = false;
  flush.resolve();
  await attempt;
  expect(deps.postJson).not.toHaveBeenCalled();
  expect(appState.trainStarting).toBe(false);
  expect(appState.trainStartToken).toBeNull();
  expect(deps.trainRowError).not.toHaveBeenCalled();
});

it("an invalidated rehearsal start cleans up when its Build flush rejects", async () => {
  const flush = deferred();
  const { appState, deps, run } = rehearsalHarness(flush);
  const token = {}; let active = true;
  appState.trainStartToken = token;
  const attempt = run("all_lines", { entryToken: token, isCurrent: () => active });
  await vi.waitFor(() => expect(deps.hardFlushBuild).toHaveBeenCalled());
  active = false;
  flush.reject(new Error("offline"));
  await attempt;
  expect(deps.postJson).not.toHaveBeenCalled();
  expect(appState.trainStarting).toBe(false);
  expect(appState.trainStartToken).toBeNull();
  expect(deps.trainRowError).not.toHaveBeenCalled();
  expect(deps.syncTrainSessionControls).toHaveBeenCalled();
});


function practiceHarness(loads, flush = async () => {}) {
  const appState = { trainMode: "play", playStartToken: 0 };
  const deps = { ...asSlices(appState), START_FEN: "start", playBook: () => "repertoire", selectedTrainRepertoireIds: () => ["r"], trainRowError: vi.fn(), hardFlushBuild: vi.fn(flush),
    playRepertoireMeta: () => [{ id: "r", color: "white" }], loadPlayRepertoirePayload: loads, normalizePlayRepertoire: (payload) => ({ id: payload.repertoire_id, rootId: "root" }),
    playCursorsAtFen: () => ({ r: ["root"] }), resolvePlayColor: () => "white", playPickerColor: () => "white", boardInfo: vi.fn(async () => ({ fen: "start", legal_moves: [] })), effectiveMaiaRating: () => 1500,
    boards: { train: { setOrientation: vi.fn() } }, paintPlayPosition: vi.fn(), sideToMoveFromFen: () => "white", localPremoveMoves: () => [], playBookLabel: () => "Repertoire",
    renderPlayTrail: vi.fn(), syncTrainSessionControls: vi.fn(), getSharedMaia3Provider: () => ({ warmup: async () => {} }), playOpponentReply: vi.fn(async () => {}) };
  return { ...asSlices(appState), appState, deps, run: compile("async function startPlaySession(", deps) };
}

it("a canceled Practice start cannot adopt its tree over a replacement start", async () => {
  const first = deferred(), second = deferred();
  const loads = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { appState, run } = practiceHarness(loads);
  const stale = run();
  await vi.waitFor(() => expect(loads).toHaveBeenCalledTimes(1));
  appState.playStartToken += 1;
  const replacement = run();
  await vi.waitFor(() => expect(loads).toHaveBeenCalledTimes(2));
  first.resolve({ repertoire_id: "r" }); expect(await stale).toBe(false); expect(appState.play).toBeUndefined();
  second.resolve({ repertoire_id: "r" }); expect(await replacement).toBe(true);
  expect(appState.play).toMatchObject({ active: true, book: "repertoire" });
});

it("a canceled Practice start does not paint a stale Build flush failure", async () => {
  const flush = deferred();
  const { appState, deps, run } = practiceHarness(vi.fn(), () => flush.promise);
  const attempt = run();
  await vi.waitFor(() => expect(deps.hardFlushBuild).toHaveBeenCalled());
  appState.playStartToken += 1;
  flush.reject(new Error("offline")); expect(await attempt).toBe(false);
  expect(deps.trainRowError).not.toHaveBeenCalled();
});


it("Scout bulk counts only confirmed complete lines and continues after failures", async () => {
  const writerSource = readFileSync(new URL("./views/scout-prep-writer.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // Private writer functions are indented inside createScoutPrepWriter.
  const code = writerSource.replace(/^  /gm, "");
  const notices = { isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), completeJob: vi.fn() };
  const write = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("node");
  const run = compile("async function runPrepareAll(", {
    scoutLineKey: (ucis) => ucis.join(" "), setStatus: vi.fn(), notices, countOf, otherColor: () => "black",
    // Bulk add already holds the Scout busy flag, so it picks without the
    // guarded entry point (which would refuse and do nothing). No line branches, so none is skipped.
    pickRepertoire: async () => "r", writeLineToRep: write, hardFlushBuild: vi.fn(), latestLookup: async () => ({ rootId: null, childUci: new Map() }), resolveDivergences: async () => ({ skip: new Set() }),
  }, "", code);
  await run(["a", "b", "c"].map((uci) => ({ ucis: [uci], sans: [uci] })), "white");
  expect(write).toHaveBeenCalledTimes(3);
  expect(notices.completeJob).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("1 line") }));
  expect(notices.completeJob.mock.calls[0][0].message).toContain("2 failed");
});

it("the application wires Scout's handoff recorder", async () => {
  const rememberHandoff = vi.fn();
  const createScoutView = vi.fn((deps) => { deps.rememberHandoff?.({ source: "scout" }); return {}; });
  const noop = () => {};
  const deps = Object.fromEntries(["escapeHtml", "setStatus", "switchView", "api", "showInputModal",
    "createRepertoirePrompt", "editRepertoire", "boardAfterMove", "buildProvisionalNode", "hardFlushBuild",
    "selectBuildNode", "resolveBuildId", "setBuildSync", "notices", "parseFenBoard", "pieceSvg",
    "startLichessOAuth", "loadPgnIntoAnalyze", "effectiveMaiaRating", "maiaAnalysisEnabled",
    "scoutPickedUsernames", "requireSignIn", "effectiveStockfishDepth", "queueBuildAdd"].map((key) => [key, noop]));
  const run = compile("async function ensureScoutView(", { ...deps, rememberHandoff,
    preloadScoutView: async () => ({ createScoutView }) }, "let scoutView = null");
  await run();
  expect(rememberHandoff).toHaveBeenCalledWith({ source: "scout" });
});


function buildFlushHarness() {
  const op = { tempId: "tmp-a", parentRef: "root", uci: "e2e4", repertoire_id: "r" };
  const appState = { build: { repertoire_id: "r", revision: 1 }, buildPending: [op], buildPendingDeletes: [],
    buildSyncRetry: 0, buildIdMap: {}, buildNodeById: new Map([["tmp-a", {}]]), buildCurrentNodeId: "tmp-a" };
  const deps = { ...asSlices(appState), currentOwnerId: () => "owner", captureBuildContext: () => () => true,
    resolveBuildId: (id) => id, acquireFlushLock: () => true, OUTBOX_TAB_ID: "tab", clearTimeout: vi.fn(), setBuildSync: vi.fn(),
    buildOpMatchesRepertoire: (op, id) => op.repertoire_id === id, setStatus: vi.fn(),
    postJson: vi.fn(async () => ({ repertoire_id: "r", revision: 2, id_map: { "tmp-a": "real" }, nodes: [{ id: "real" }] })),
    buildAddId: (op) => op.tempId, buildDeleteId: (op) => op.id,
    persistOutbox: vi.fn(), hydrateBuild: vi.fn(async () => { throw new Error("render failed"); }),
    setStatusError: vi.fn(), hasPendingBuildOpsFor: () => false, clearOutboxWhenQuiescent: vi.fn(),
    releaseFlushLock: vi.fn(), classifySyncError: () => ({ kind: "network" }), describeSyncError: () => "error",
    setTimeout: vi.fn(), BUILD_FLUSH_MAX_BACKOFF_MS: 30000, scheduleBuildFlush: vi.fn(),
    reapplyPendingBuildNodes: vi.fn(), reapplyPendingBuildDeletes: vi.fn(),
    selectBuildNode: vi.fn(),
    // build-flush.js, reduced to the whole-payload answer these tests send back.
    flushSince: () => 1, applyFlushReply: (reply, hydrate) => hydrate(reply, appState.buildCurrentNodeId),
    postBuildAdds: (rep, batch, since) => deps.postJson("/api/build/add-moves", { repertoire_id: rep, since, moves: batch.map(({ tempId, parentRef, uci }) => ({ tempId, parentRef, uci })) }),
  };
  return { op, ...asSlices(appState), appState, deps, run: queueFlush("function flushBuildMoves(", deps) };
}

it("deleting a saved analysis hides the row and only calls the server after the undo window", async () => {
  const appState = { pendingAnalysisDeletes: new Set() };
  const statuses = [];
  const removed = [];
  const row = { remove: vi.fn(), closest: () => row };
  const button = { dataset: { historyDelete: "g1", historyLabel: "me_user vs opp_one" }, closest: () => row };
  const deps = {
    ...asSlices(appState), html,
    showUndoToast: vi.fn(),
    setStatus: (message, options) => statuses.push([message, options]),
    loadAnalysisHistory: vi.fn(),
    api: vi.fn((path, options) => {
      removed.push([path, options.method]);
      return Promise.resolve({ deleted: true });
    }),
  };
  const del = compile("function deleteSavedAnalysis(", deps);

  // No host element: the row still leaves and the empty hint is skipped safely.
  globalThis.document = { getElementById: () => null };
  del(button);
  expect(appState.pendingAnalysisDeletes.has("g1")).toBe(true);
  expect(row.remove).toHaveBeenCalled();
  expect(deps.api).not.toHaveBeenCalled(); // the window is still open
  expect(deps.loadAnalysisHistory).not.toHaveBeenCalled();

  // Undo restores the list from the server without ever deleting.
  deps.showUndoToast.mock.calls[0][0].onUndo();
  expect(appState.pendingAnalysisDeletes.has("g1")).toBe(false);
  expect(deps.loadAnalysisHistory).toHaveBeenCalled();
  expect(deps.api).not.toHaveBeenCalled();

  // Committing the window deletes, and clears the pending marker on success.
  deps.showUndoToast.mock.calls[0][0].onCommit();
  await Promise.resolve();
  await Promise.resolve();
  expect(removed).toEqual([["/api/analyses/g1", "DELETE"]]);
  expect(appState.pendingAnalysisDeletes.has("g1")).toBe(false);

  delete globalThis.document;
});

it("a failed analysis delete restores the row and says why", async () => {
  const appState = { pendingAnalysisDeletes: new Set() };
  const statuses = [];
  const row = { remove: vi.fn(), closest: () => row };
  const button = { dataset: { historyDelete: "g9", historyLabel: "a vs b" }, closest: () => row };
  const deps = {
    ...asSlices(appState), html,
    showUndoToast: vi.fn(),
    setStatus: (message, options) => statuses.push([message, options]),
    loadAnalysisHistory: vi.fn(),
    api: vi.fn(() => Promise.reject(new Error("Request failed (500)"))),
  };
  globalThis.document = { getElementById: () => null };
  compile("function deleteSavedAnalysis(", deps)(button);
  deps.showUndoToast.mock.calls[0][0].onCommit();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(statuses[0][0]).toContain("Request failed (500)");
  expect(statuses[0][1]).toEqual({ severity: "error" });
  expect(deps.loadAnalysisHistory).toHaveBeenCalled();
  delete globalThis.document;
});

// Production 2026-10-14: one edit made elsewhere moved the server revision and
// every queued edit then hit 409 on each flush. The server now rebases each edit
// onto the current tree, so a queued edit carries no revision and just lands.
// (``since`` only asks for the changes after the tab's revision in the answer.)
it("a queued Build edit carries no base revision and lands after edits made elsewhere", async () => {
  const h = buildFlushHarness();
  h.deps.hydrateBuild.mockResolvedValue(undefined);
  expect(await h.run()).toBe(true);
  expect(h.deps.postJson).toHaveBeenCalledWith("/api/build/add-moves", {
    repertoire_id: "r", since: 1, moves: [{ tempId: "tmp-a", parentRef: "root", uci: "e2e4" }] });
  expect(h.buildState.buildPending).toEqual([]);
});

it("moves whose line was deleted elsewhere are settled with one notice", async () => {
  const h = buildFlushHarness();
  h.deps.hydrateBuild.mockResolvedValue(undefined);
  h.deps.postJson.mockResolvedValueOnce({ repertoire_id: "r", revision: 3, id_map: {}, dropped: ["tmp-a"], nodes: [{ id: "root" }] });
  expect(await h.run()).toBe(true);
  expect(h.buildState.buildPending).toEqual([]);
  expect(h.deps.persistOutbox).toHaveBeenCalledWith(expect.objectContaining({ adds: ["tmp-a"] }));
  expect(h.deps.setStatus).toHaveBeenCalledWith("1 move not saved: line deleted elsewhere", { severity: "warning" });
});

it("passes the selected line to hydration to resolve against surviving and pending nodes", async () => {
  const h = buildFlushHarness();
  h.deps.hydrateBuild.mockResolvedValue(undefined);
  h.buildState.buildNodeById = new Map([["tmp-a", { parent_id: "c5" }], ["c5", { parent_id: "e4" }], ["e4", { parent_id: "root" }]]);
  h.deps.postJson.mockResolvedValueOnce({ repertoire_id: "r", revision: 3, id_map: {}, dropped: ["tmp-a"],
    nodes: [{ id: "root" }, { id: "e4" }] });
  expect(await h.run()).toBe(true);
  expect(h.deps.hydrateBuild).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }), "tmp-a");
});

it("queued edits for a repertoire that is not open still save", async () => {
  const h = buildFlushHarness();
  h.buildState.build = null;
  h.deps.captureBuildContext = () => () => false;
  expect(await h.run()).toBe(true);
  expect(h.deps.postJson.mock.calls[0][1].repertoire_id).toBe("r");
  expect(h.deps.hydrateBuild).not.toHaveBeenCalled();
  expect(h.buildState.buildPending).toEqual([]);
  expect(h.deps.persistOutbox).toHaveBeenCalledWith(expect.objectContaining({ adds: ["tmp-a"] }));
});

it("Build render failure after commit does not requeue confirmed adds", async () => {
  const { run, appState, deps } = buildFlushHarness();
  expect(await run()).toBe(true);
  expect(appState.buildPending).toEqual([]);
  expect(appState.buildIdMap["tmp-a"]).toBe("real");
  expect(deps.persistOutbox).toHaveBeenCalledWith(expect.objectContaining({ adds: ["tmp-a"] }));
  expect(deps.postJson).toHaveBeenCalledTimes(1);
});


function trainFlushHarness() {
  let owner = "alice";
  const response = deferred();
  const sync = { pending: [{ session_id: "s", session_generation: "old", node_id: "n", correct: true, attempt_uuid: "u" }], dirty: true, retry: 0 };
  const appState = { trainSync: sync, smart: { sessionId: "s", generation: "old", stateVersion: 3, cardIndex: 1, queue: [{ encoded: "old-card" }] } };
  const deps = { ...asSlices(appState), currentOwnerId: () => owner, flushGroups, groupAttempts, ungroupAttempts,
    setTrainSyncState: vi.fn(), clearTimeout: vi.fn(), postJson: vi.fn(() => response.promise),
    localDateString: () => "2026-10-02", persistOutbox: vi.fn(), trainAttemptId: (a) => a.attempt_uuid,
    classifySyncError, setStatus: vi.fn(), setTimeout: vi.fn(), TRAIN_SYNC_MAX_BACKOFF_MS: 30000,
    clearOutboxWhenQuiescent: vi.fn(), scheduleTrainSync: vi.fn() };
  return { run: queueFlush("function flushTrainSync(", deps), ...asSlices(appState), appState, deps, response, setOwner: (next) => { owner = next; } };
}

it("a late Smart sync failure keeps the old generation and cannot dirty its rebuilt session", async () => {
  const h = trainFlushHarness();
  const pending = h.run();
  await Promise.resolve();
  expect(h.deps.postJson.mock.calls[0][1]).toMatchObject({ session_generation: "old", card_index: 1, queue: ["old-card"] });
  h.trainState.smart = { sessionId: "s", generation: "new", queue: [], cardIndex: 0 };
  h.response.reject(Object.assign(new Error("offline"), { status: 503 }));
  expect(await pending).toBe(false);
  expect(h.trainState.trainSync.pending[0].session_generation).toBe("old");
  expect(h.trainState.trainSync.dirty).toBe(false);
});

it("Smart sync sends the captured version and advances it only after accepting state", async () => {
  const h = trainFlushHarness();
  const pending = h.run();
  await Promise.resolve();
  expect(h.deps.postJson.mock.calls[0][1].state_version).toBe(3);
  h.response.resolve({ state_applied: true, state_version: 5 });
  await pending;
  expect(h.trainState.smart.stateVersion).toBe(5);
});

it("Smart sync settles attempts but does not adopt a conflicting state's version", async () => {
  const h = trainFlushHarness();
  const pending = h.run();
  h.response.resolve({ synced: 1, state_applied: false, state_version: 7 });
  await pending;
  expect(h.trainState.smart.stateVersion).toBe(3);
  expect(h.trainState.trainSync.pending).toEqual([]);
  expect(h.deps.setStatus).toHaveBeenCalledWith(expect.stringContaining("Resume"), { severity: "error" });
});

it("changing owners during the durable checkpoint releases the old flush without sending", async () => {
  const h = trainFlushHarness();
  const checkpoint = deferred();
  h.deps.persistOutbox.mockImplementationOnce(() => checkpoint.promise);
  const pending = h.run();
  const old = h.trainState.trainSync;
  h.setOwner("bob");
  h.trainState.trainSync = { pending: [], dirty: false };
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
  h.trainState.trainSync = bob;
  h.response.resolve({ day_streak: 99 });
  expect(await pending).toBe(false);
  expect(h.trainState.trainSync).toBe(bob);
  expect(h.appState.dayStreak).toBeUndefined();
  expect(h.deps.persistOutbox).not.toHaveBeenCalled();
});


it("a late Generate save response cannot hydrate the repertoire the user left", async () => {
  const start = source.indexOf('    const payload = await postBuildWrite(', source.indexOf('    notices.lockJob("saving'));
  const end = source.indexOf('    const summary = payload.summary', start);
  const response = deferred();
  let current = true;
  const hydrateBuild = vi.fn();
  const run = new Function("postBuildWrite", "hydrateBuild", "isCurrent", "controller",
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
  h.buildState.buildNodeById.delete("tmp-a");
  h.buildState.buildPendingDeletes.push({ id: "tmp-a", repertoire_id: "r" });
  response.reject(new Error("response lost"));
  expect(await pending).toBe(false);
  expect(h.buildState.buildPending).toEqual([h.op]);
  expect(h.buildState.buildPendingDeletes).toHaveLength(1);
  h.deps.hydrateBuild.mockResolvedValue(undefined);
  h.deps.hasPendingBuildOpsFor = () => true;
  // Use the real ID lookup; queued deletion must wait while the add retries.
  h.deps.resolveBuildId = (entry) => {
    const id = entry?.id || entry;
    return h.buildState.buildIdMap[id] || id;
  };
  const retry = queueFlush("function flushBuildMoves(", h.deps);
  expect(await retry()).toBe(true);
  expect(h.deps.postJson.mock.calls[1][0]).toBe("/api/build/add-moves");
  expect(h.deps.postJson.mock.calls[1][1].moves[0].tempId).toBe("tmp-a");
  expect(h.buildState.buildPendingDeletes).toHaveLength(1);
  expect(h.deps.resolveBuildId(h.buildState.buildPendingDeletes[0])).toBe("real");
});


it("an older Settings GET cannot repaint state after a newer save", async () => {
  const get = deferred(), post = deferred();
  const appState = { signedIn: true };
  const view = { renderSettings: vi.fn() };
  const deps = { ...asSlices(appState), currentOwnerId: () => "owner", ensureSettingsView: async () => view,
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

it("a Scout line queued into the open repertoire is flushed by that repertoire", () => {
  // 2026-10-08 audit: Scout pushed untagged ops, so every flush deferred them as
  // "edits for another repertoire" and Add to prep never saved.
  const appState = { build: { repertoire_id: "rep", revision: 3, nodes: [] }, buildNodeById: new Map(), buildPending: [] };
  const queueBuildAdd = compile("function queueBuildAdd(", { ...asSlices(appState), resolveBuildId: id => id });
  const matches = compile("function buildOpMatchesRepertoire(", {});
  queueBuildAdd({ id: "tmp-1", parent_id: "root", uci: "e2e4" });
  expect(appState.buildPending[0]).toMatchObject({ tempId: "tmp-1", parentRef: "root", uci: "e2e4" });
  expect(matches(appState.buildPending[0], "rep")).toBe(true);
  const scout = readFileSync(new URL("./views/scout.js", import.meta.url), "utf8");
  expect(scout).not.toMatch(/buildPending/);
});
