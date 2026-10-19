import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { isNothingToTrainError, queueRepertoireForStart } from "./train-start.js";

const source = appSource();

function startSmartTrainingSource() {
  const start = source.indexOf("async function startSmartTraining(");
  const end = source.indexOf("\nasync function ", start + 10);
  return source.slice(start, end);
}

function startWith(message, status = 400) {
  const code = startSmartTrainingSource();
  const deps = {
    appState: { trainMode: "smart" }, currentOwnerId: () => "owner",
    setStatus: vi.fn(), setStatusError: vi.fn(), setTrainBanner: vi.fn(),
    hardFlushBuild: async () => {}, flushTrainSync: async () => true,
    loadTrainResume: async () => ({}), isAuthError: () => false, isNothingToTrainError, queueRepertoireForStart,
    postJson: async () => { throw Object.assign(new Error(message), { status }); },
  };
  const run = new Function(...Object.keys(deps), `let smartStartSeq = 0; ${code}\nreturn startSmartTraining;`)(...Object.values(deps));
  return { run, deps };
}

it.each([
  "no active repertoires to train",
  "repertoire has no trainable moves yet",
  "repertoires have no trainable moves yet",
  "repertoire has no trainable lines yet",
])("a start with '%s' leaves the disabled Start as the only signal", async (message) => {
  const { run, deps } = startWith(message);
  await run();
  expect(deps.setTrainBanner).toHaveBeenLastCalledWith("idle", "No moves to train yet", "");
  expect(deps.setStatusError).not.toHaveBeenCalled();
});

it("still reports a queue failure that is not a missing-lines state", async () => {
  const { run, deps } = startWith("database is down", 500);
  await run();
  expect(deps.setStatusError).toHaveBeenCalledWith("database is down");
  expect(deps.setTrainBanner).toHaveBeenLastCalledWith("done", "Couldn't build your queue", "Try Start again in a moment.");
});

// A start the server accepts but fills with no cards (a queue whose repertoires
// all went empty between the preview and the click) used to raise a toast that
// repeated the banner word for word. The setup screen already carries both the
// reason and the fix, so the start must leave it as the only signal.
it("a start that builds an empty queue leaves the banner as the only signal", async () => {
  const deps = {
    appState: { trainMode: "smart" },
    currentOwnerId: () => "owner",
    setStatus: vi.fn(), setStatusError: vi.fn(), setTrainBanner: vi.fn(),
    hardFlushBuild: async () => {}, flushTrainSync: async () => true,
    loadTrainResume: async () => ({ mapTrainUiSession: () => ({ queue: [], sessionId: "s1" }) }),
    isAuthError: () => false, isNothingToTrainError,
    queueRepertoireForStart: () => null,
    postJson: async () => ({ card_kinds: [], requeue_gap: 3 }),
    trainStatsReset: vi.fn(), invalidateTrainSessionPreview: vi.fn(), clearBlitzTimer: vi.fn(),
  };
  const run = new Function(
    ...Object.keys(deps),
    `let smartStartSeq = 0, trainSessionMemo = null; ${startSmartTrainingSource()}\nreturn startSmartTraining;`,
  )(...Object.values(deps));
  await run();
  expect(deps.setStatus).not.toHaveBeenCalled();
  expect(deps.setStatusError).not.toHaveBeenCalled();
  expect(deps.setTrainBanner).toHaveBeenLastCalledWith("idle", "No moves to train yet", "");
});