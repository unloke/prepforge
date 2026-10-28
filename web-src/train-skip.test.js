import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./controllers/train-session.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("async function skipTrainingLine()");
const body = source.slice(start, source.indexOf("\n}\n", start) + 2);
function harness(postJson = vi.fn(async () => ({ prompt: { session_id: "s", current_index: 1 } }))) {
  const appState = { trainMode: "all_lines", training: { prompt: { session_id: "s" } }, trainStats: { skipped: 0, mistakes: 1 }, trainAttempt: 3 };
  const deps = { appState, postJson, currentOwnerId: () => "u", currentTrainingPrompt: () => appState.training.prompt,
    setStatus: vi.fn(), setStatusError: vi.fn(), skipSmartCard: vi.fn(), syncTrainSessionControls: vi.fn(),
    renderTraining: vi.fn(), finishTrainingSession: vi.fn() };
  const skip = new Function(...Object.keys(deps), `${body}; return skipTrainingLine;`)(...Object.values(deps));
  return { ...deps, skip };
}
it("records a skipped line and starts the next line on its first attempt", async () => {
  const h = harness(); await h.skip();
  expect(h.appState.trainStats).toEqual({ skipped: 1, mistakes: 1 });
  expect(h.appState.trainAttempt).toBe(1);
  expect(h.renderTraining).toHaveBeenCalledWith({ session_id: "s", current_index: 1 });
  expect(h.appState.trainBusy).toBe(false);
});
it("counts the last skip before finishing the summary", async () => {
  const h = harness(vi.fn(async () => ({ prompt: null })));
  h.finishTrainingSession.mockImplementation(() => expect(h.appState.trainStats.skipped).toBe(1));
  await h.skip(); expect(h.finishTrainingSession).toHaveBeenCalledOnce();
});
it("ignores repeated skips while the first request is pending", async () => {
  let resolve; const h = harness(vi.fn(() => new Promise(r => { resolve = r; })));
  const pending = h.skip(); await h.skip();
  expect(h.postJson).toHaveBeenCalledOnce(); resolve({ prompt: null }); await pending;
  expect(h.appState.trainStats.skipped).toBe(1);
});
it("does not count a rejected request or a skip from an abandoned session", async () => {
  const h = harness(vi.fn(async () => { throw new Error("Offline"); })); await h.skip();
  expect(h.appState.trainStats.skipped).toBe(0); expect(h.appState.trainBusy).toBe(false);
  let resolve; const other = harness(vi.fn(() => new Promise(r => { resolve = r; })));
  const pending = other.skip(); other.appState.training = { prompt: { session_id: "new" } };
  resolve({ prompt: null }); await pending;
  expect(other.appState.trainStats.skipped).toBe(0); expect(other.finishTrainingSession).not.toHaveBeenCalled();
});
