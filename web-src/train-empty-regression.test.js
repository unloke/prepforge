// A Start with nothing to serve is a state of the Due row, not a fault: the
// reason lands in that row (and its Start already reads "Open Repertoire"),
// with no toast repeating it and no generic error banner.
import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { isNothingToTrainError } from "./train-start.js";
import { asSlices } from "./state/as-slices.fixture.js";

const source = appSource();

function startSmartTrainingSource() {
  const start = source.indexOf("async function startSmartTraining(");
  const end = source.indexOf("\nasync function ", start + 10);
  return source.slice(start, end);
}

function cancelStaleTrainStartSource() {
  const start = source.indexOf("function cancelStaleTrainStart(");
  return source.slice(start, source.indexOf("\n", start) + 1);
}

function harness(postJson, resume = {}) {
  const deps = {
    ...asSlices({ trainMode: "smart", trainStarting: true }), currentOwnerId: () => "owner",
    setStatus: vi.fn(), setStatusError: vi.fn(), setTrainBanner: vi.fn(), trainRowError: vi.fn(),
    syncTrainSessionControls: vi.fn(), hardFlushBuild: async () => {}, flushTrainSync: async () => true,
    loadTrainResume: async () => resume, isAuthError: () => false, isNothingToTrainError, postJson,
    trainStatsReset: vi.fn(), invalidateTrainPreview: vi.fn(), clearBlitzTimer: vi.fn(),
    accountService: () => ({ handleAuthRequired: vi.fn() }),
  };
  const run = new Function(...Object.keys(deps), `let smartStartSeq = 0, trainSessionMemo = {}; ${cancelStaleTrainStartSource()}\n${startSmartTrainingSource()}\nreturn startSmartTraining;`)(...Object.values(deps));
  return { run, deps };
}

const rejecting = (message, status = 400) => async () => { throw Object.assign(new Error(message), { status }); };

it.each([
  "no active repertoires to train",
  "repertoire has no trainable moves yet",
  "repertoires have no trainable moves yet",
  "repertoire has no trainable lines yet",
])("a start with '%s' says so in the Due row only", async (message) => {
  const { run, deps } = harness(rejecting(message));
  await run();
  expect(deps.trainRowError).toHaveBeenCalledWith("smart", "Nothing to train here. Add lines in Repertoire.");
  expect(deps.setStatusError).not.toHaveBeenCalled();
  expect(deps.setStatus).not.toHaveBeenCalled();
  expect(deps.appState.trainStarting).toBe(false);
});

it("a real failure is named as one, still in the row", async () => {
  const { run, deps } = harness(rejecting("database is down", 500));
  await run();
  expect(deps.trainRowError).toHaveBeenCalledWith("smart", "Couldn't build your queue. Try again in a moment.");
  expect(deps.setStatusError).not.toHaveBeenCalled();
});

it("a start the server accepts but fills with no cards goes back to Home with the reason", async () => {
  const { run, deps } = harness(async () => ({ card_kinds: [], requeue_gap: 3 }),
    { mapTrainUiSession: () => ({ queue: [], sessionId: "s1" }) });
  await run();
  expect(deps.trainRowError).toHaveBeenCalledWith("smart", "Nothing to train here. Add lines in Repertoire.");
  expect(deps.setStatus).not.toHaveBeenCalled();
  expect(deps.appState.trainStarting).toBe(false);
});

it("posts the scope it was given: one repertoire, or all of them", async () => {
  const post = vi.fn(rejecting("stop"));
  const { run, deps } = harness(post);
  await run({ repertoireId: "r1" });
  expect(post).toHaveBeenLastCalledWith("/api/train/smart/start", { mixed: false, fresh: false, repertoire_id: "r1" });
  deps.appState.trainScope = { repertoireId: null };
  await run({});
  expect(post).toHaveBeenLastCalledWith("/api/train/smart/start", { mixed: true, fresh: false });
  await run({ repertoireId: "r1", targetNodeIds: ["n1"] });
  expect(post).toHaveBeenLastCalledWith("/api/train/smart/start", { mixed: false, fresh: true, repertoire_id: "r1", target_node_ids: ["n1"] });
});

it("does not post a queue after its navigation entry is invalidated", async () => {
  const post = vi.fn(rejecting("unexpected"));
  let release;
  const { run } = harness(post, new Promise((done) => { release = done; }));
  let active = true;
  const attempt = run({ repertoireId: "r1", isCurrent: () => active });
  active = false;
  release({});
  await attempt;
  expect(post).not.toHaveBeenCalled();
});

it("does not adopt a queue after its navigation entry is invalidated mid-post", async () => {
  let release, active = true;
  const post = vi.fn(() => new Promise((done) => { release = done; }));
  const { run, deps } = harness(post, { mapTrainUiSession: () => ({ queue: [{}], sessionId: "s1" }) });
  const attempt = run({ repertoireId: "r1", isCurrent: () => active });
  await vi.waitFor(() => expect(post).toHaveBeenCalled());
  active = false;
  release({ card_kinds: [], requeue_gap: 3 });
  await attempt;
  expect(deps.trainStatsReset).not.toHaveBeenCalled();
  expect(deps.appState.smart).toBeUndefined();
});

it("a start canceled before its post clears its own starting state", async () => {
  const post = vi.fn(rejecting("unexpected"));
  let release;
  const { run, deps } = harness(post, new Promise((done) => { release = done; }));
  const token = {};
  let active = true;
  deps.appState.trainStartToken = token;
  const attempt = run({ repertoireId: "r1", entryToken: token, isCurrent: () => active });
  active = false;
  release({});
  await attempt;
  expect(post).not.toHaveBeenCalled();
  expect(deps.appState.trainStarting).toBe(false);
  expect(deps.appState.trainStartToken).toBeNull();
  expect(deps.setTrainBanner).toHaveBeenLastCalledWith("move", "", "");
  expect(deps.syncTrainSessionControls).toHaveBeenCalled();
});

it("a start canceled mid-post clears its own starting state without adopting the queue", async () => {
  let release, active = true;
  const post = vi.fn(() => new Promise((done) => { release = done; }));
  const { run, deps } = harness(post, { mapTrainUiSession: () => ({ queue: [{}], sessionId: "s1" }) });
  const token = {};
  deps.appState.trainStartToken = token;
  const attempt = run({ repertoireId: "r1", entryToken: token, isCurrent: () => active });
  await vi.waitFor(() => expect(post).toHaveBeenCalled());
  active = false;
  release({ card_kinds: [], requeue_gap: 3 });
  await attempt;
  expect(deps.trainStatsReset).not.toHaveBeenCalled();
  expect(deps.appState.smart).toBeUndefined();
  expect(deps.appState.trainStarting).toBe(false);
  expect(deps.appState.trainStartToken).toBeNull();
  expect(deps.syncTrainSessionControls).toHaveBeenCalled();
});

it("a stale canceled start does not clear a replacement start's state", async () => {
  let release, active = true;
  const post = vi.fn(() => new Promise((done) => { release = done; }));
  const { run, deps } = harness(post, { mapTrainUiSession: () => ({ queue: [{}], sessionId: "s1" }) });
  const oldToken = {}, newToken = {};
  deps.appState.trainStartToken = oldToken;
  const attempt = run({ repertoireId: "r1", entryToken: oldToken, isCurrent: () => active });
  await vi.waitFor(() => expect(post).toHaveBeenCalled());
  active = false;
  deps.appState.trainStarting = true;
  deps.appState.trainStartToken = newToken;
  release({ card_kinds: [], requeue_gap: 3 });
  await attempt;
  expect(deps.appState.trainStarting).toBe(true);
  expect(deps.appState.trainStartToken).toBe(newToken);
  expect(deps.setTrainBanner).not.toHaveBeenCalledWith("move", "", "");
});

it("a resumed queue raises no toast: Home already said Resume", () => {
  const code = startSmartTrainingSource();
  expect(code).not.toMatch(/setStatus\(/);
});
