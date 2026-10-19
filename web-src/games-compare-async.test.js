import { expect, it, vi } from "vitest";
import { MAX_FETCH } from "./generated/shared-constants.js";
import { countOf } from "./plural.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
function harness() {
  const appState = { signedIn: true, accountUserId: "owner" };
  let selection = { linkedMode: "none", external: ["first"], accountIds: [] };
  const requests = [];
  const button = { disabled: false };
  const resultsHost = { innerHTML: "" };
  const deps = {
    appState, countOf, MAX_FETCH, requireSignIn: () => true,
    gamesSourceSelection: () => selection, lichessAccounts: () => [],
    resolveFetchUsernames: ({ selection }) => selection.external,
    gamesSourceAccountIds: () => [], normalizeSelection: (s) => s,
    document: {
      getElementById: (id) => id === "replay-count" ? { value: 10 } : id === "replay-results" ? resultsHost : button,
    },
    postJson: () => new Promise((resolve) => requests.push(resolve)),
    renderReplayResults: vi.fn(), renderLedgerSkeleton: vi.fn(),
    setStatus: vi.fn(), setStatusError: vi.fn(),
  };
  const start = source.indexOf("async function runLichessCompare(");
  const end = source.indexOf("\n}\n", start) + 2;
  const run = new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
  return { appState, requests, button, deps, resultsHost, run, change: () => { selection = { ...selection, external: ["second"] }; } };
}

it("shows the ledger skeleton while the check is in flight", async () => {
  const h = harness();
  const pending = h.run();
  await Promise.resolve();
  expect(h.deps.renderLedgerSkeleton).toHaveBeenCalledTimes(1);
  // The rows the fetch will replace, not the pre-check idle card.
  expect(h.deps.renderLedgerSkeleton.mock.calls[0][0]).toBe(h.resultsHost);
  h.requests[0]({ games: [], count: 0 });
  await pending;
});

it("drops an automatic Games response when its sources change", async () => {
  const h = harness();
  const pending = h.run();
  h.change();
  h.requests[0]({ games: [], count: 0 });
  await pending;
  expect(h.appState.replayResults).toBeUndefined();
  expect(h.deps.renderReplayResults).not.toHaveBeenCalled();
  expect(h.button.disabled).toBe(false);
});

it("lets the latest Check own results and its busy state", async () => {
  const h = harness();
  const first = h.run();
  const second = h.run();
  h.requests[0]({ games: [], count: 1 });
  await first;
  expect(h.button.disabled).toBe(true);
  expect(h.deps.renderReplayResults).not.toHaveBeenCalled();
  h.requests[1]({ games: [], count: 2 });
  await second;
  expect(h.appState.replayResults.count).toBe(2);
  expect(h.button.disabled).toBe(false);
});

it("uses the singular when a compare returns one game", async () => {
  const h = harness();
  const pending = h.run();
  h.requests[0]({ games: [], count: 1, misses_recorded: 1, username: "self" });
  await pending;
  expect(h.deps.setStatus).toHaveBeenCalledWith("Fetched 1 game · 1 forgotten move added to training");
});
