// A Start with nothing to serve is a state of the Due row, not a fault: the
// reason lands in that row (and its Start already reads "Open Repertoire"),
// with no toast repeating it and no generic error banner.
import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { isNothingToTrainError } from "./train-start.js";

const source = appSource();

function startSmartTrainingSource() {
  const start = source.indexOf("async function startSmartTraining(");
  const end = source.indexOf("\nasync function ", start + 10);
  return source.slice(start, end);
}

function harness(postJson, resume = {}) {
  const deps = {
    appState: { trainMode: "smart", trainStarting: true }, currentOwnerId: () => "owner",
    setStatus: vi.fn(), setStatusError: vi.fn(), setTrainBanner: vi.fn(), trainRowError: vi.fn(),
    syncTrainSessionControls: vi.fn(), hardFlushBuild: async () => {}, flushTrainSync: async () => true,
    loadTrainResume: async () => resume, isAuthError: () => false, isNothingToTrainError, postJson,
    trainStatsReset: vi.fn(), invalidateTrainPreview: vi.fn(), clearBlitzTimer: vi.fn(),
    accountService: () => ({ handleAuthRequired: vi.fn() }),
  };
  const run = new Function(...Object.keys(deps), `let smartStartSeq = 0, trainSessionMemo = {}; ${startSmartTrainingSource()}\nreturn startSmartTraining;`)(...Object.values(deps));
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

it("a resumed queue raises no toast: Home already said Resume", () => {
  const code = startSmartTrainingSource();
  expect(code).not.toMatch(/setStatus\(/);
});
