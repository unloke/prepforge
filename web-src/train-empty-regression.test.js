import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

it("an account with no active repertoire gets an actionable empty state", async () => {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function startSmartTraining(");
  const end = source.indexOf("\nasync function ", start + 10);
  const code = source.slice(start, end);
  const deps = {
    appState: { trainMode: "smart" }, currentOwnerId: () => "owner",
    setStatus: vi.fn(), setStatusError: vi.fn(), setTrainBanner: vi.fn(),
    hardFlushBuild: async () => {}, flushTrainSync: async () => true,
    loadTrainResume: async () => ({}), isAuthError: () => false,
    postJson: async () => { throw Object.assign(new Error("no active repertoires to train"), { status: 400 }); },
  };
  const run = new Function(...Object.keys(deps), `let smartStartSeq = 0; ${code}\nreturn startSmartTraining;`)(...Object.values(deps));
  await run();
  expect(deps.setTrainBanner).toHaveBeenLastCalledWith("done", "Nothing to train yet", "Create or activate a repertoire in Library.");
  expect(deps.setStatusError).not.toHaveBeenCalled();
});
