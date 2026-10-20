import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";

const source = appSource();

// Dropping a Games source must drop the ledger it produced: the header names
// the accounts the last Check fetched from, so a stale list would keep showing
// games from an account the user just removed.
function extract(name, endMarker) {
  const start = source.indexOf("function " + name + "(");
  const end = source.indexOf(endMarker, start + 10);
  if (start < 0 || end < 0) throw new Error("missing " + name);
  return source.slice(start, end);
}

it("clearing the Games results drops the ledger, the filter and the selection", () => {
  const html = (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ""), "");
  const saved = [];
  const summary = { hidden: false, innerHTML: "<button>" };
  const results = { innerHTML: "<section class=triage>" };
  const hint = { textContent: "" };
  const appState = { replayResults: { games: [{}] }, replayFilter: "user-error",
    replayOpen: new Set([1]), replayCheckToken: 3, authKnown: true, signedIn: true };
  const paintGamesSource = vi.fn();
  // The extracted source declares clearGamesResults/gamesIdleHint itself and
  // calls paintGamesSource, so only the names it reads are bound here.
  const deps = {
    appState,
    html,
    document: { getElementById: (id) => ({
      "replay-summary": summary, "replay-results": results, "games-idle-hint": hint,
    })[id] || null },
    saveReturnState: (...args) => saved.push(args),
    gamesSourceSelection: () => ({ linkedMode: "all", accountIds: [], external: [] }),
    lichessAccounts: () => [{ id: "a1" }],
    paintGamesSource,
  };
  const code = extract("clearGamesResults", "\n\nfunction gamesSourceAccountIds(")
    + extract("gamesIdleHint", "\nfunction bindGamesSource(");
  if (!code.includes("resetGamesResults")) throw new Error("clearGamesResults should reset through resetGamesResults");
  const clearGamesResults = new Function(...Object.keys(deps), code + "\nreturn clearGamesResults;")(...Object.values(deps));
  clearGamesResults();
  expect(appState.replayResults).toBe(null);
  expect(appState.replayFilter).toBe(null);
  expect(appState.replayOpen.size).toBe(0);
  // An in-flight Check response must not repaint the emptied panel.
  expect(appState.replayCheckToken).toBe(4);
  expect(summary.hidden).toBe(true);
  expect(summary.innerHTML).toBe("");
  expect(results.innerHTML).toContain("No games checked yet");
  expect(hint.textContent).toBe("Pick a sample size, then run a check.");
  expect(saved).toEqual([["replay", { filter: null, openIndex: null }]]);
  expect(paintGamesSource).toHaveBeenCalled();
});

it("a failed Check drops its skeleton without invalidating the in-flight token", () => {
  const html = (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ""), "");
  const skeleton = { innerHTML: '<div class="lr is-skeleton">' };
  const summary = { hidden: false, innerHTML: "<button>" };
  const appState = { replayResults: null, replayFilter: null, replayOpen: new Set(),
    replayCheckToken: 7, authKnown: true, signedIn: true };
  const deps = {
    appState, html,
    document: { getElementById: (id) => ({ "replay-summary": summary, "replay-results": skeleton })[id] || null },
    saveReturnState: () => {}, paintGamesSource: () => {},
  };
  const code = extract("resetGamesResults", "\n\nfunction gamesSourceAccountIds(");
  const resetGamesResults = new Function(...Object.keys(deps), code + "\nreturn resetGamesResults;")(...Object.values(deps));
  resetGamesResults();
  // The token is untouched, so runLichessCompare's finally still re-enables Check.
  expect(appState.replayCheckToken).toBe(7);
  expect(summary.hidden).toBe(true);
  expect(skeleton.innerHTML).toContain("No games checked yet");
  expect(skeleton.innerHTML).not.toContain("is-skeleton");
});

it("a failed Check clears the delayed progress status before painting the error", () => {
  const start = source.indexOf("async function runLichessCompare(");
  const end = source.indexOf("\n}\n", start) + 2;
  const body = source.slice(start, end);
  const catchBlock = body.slice(body.indexOf("} catch (error) {"));
  // "Fetching games from Lichess" is a routine status, shown on a 700ms timer;
  // it must be cleared or it appears beneath the error a moment later. The
  // panel keeps its own error card (keepPanel), so the idle prompt cannot
  // replace the failure the user just hit, and the card is the only place the
  // message appears.
  expect(catchBlock).toContain("resetGamesResults({ keepPanel: true });");
  expect(catchBlock).toContain("renderReplayFailure(");
  expect(catchBlock.indexOf('setStatus("")')).toBeGreaterThan(-1);
  expect(catchBlock.indexOf('setStatus("")')).toBeLessThan(catchBlock.indexOf("renderReplayFailure("));
  expect(catchBlock).not.toContain("setStatusError");
});

it("every Games source change clears the stale ledger", () => {
  const composer = source.slice(source.indexOf("function openGamesComposer("), source.indexOf("function paintGamesSource("));
  expect(composer).toContain("writeGamesSelection(sel);\n      clearGamesResults();");
  const tray = source.slice(source.indexOf("function bindGamesSource("), source.indexOf("let replayModule"));
  // One clear for the external-username unpick, one for the linked account.
  expect(tray.match(/clearGamesResults\(\);/g)).toHaveLength(2);
});
