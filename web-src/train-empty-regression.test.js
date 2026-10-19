import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { isNothingToTrainError } from "./train-start.js";

const source = appSource();

function startWith(message, status = 400) {
  const start = source.indexOf("async function startSmartTraining(");
  const end = source.indexOf("\nasync function ", start + 10);
  const code = source.slice(start, end);
  const deps = {
    appState: { trainMode: "smart" }, currentOwnerId: () => "owner",
    setStatus: vi.fn(), setStatusError: vi.fn(), setTrainBanner: vi.fn(),
    hardFlushBuild: async () => {}, flushTrainSync: async () => true,
    loadTrainResume: async () => ({}), isAuthError: () => false, isNothingToTrainError,
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