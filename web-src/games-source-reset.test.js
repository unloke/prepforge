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

it("every Games source change clears the stale ledger", () => {
  const composer = source.slice(source.indexOf("function openGamesComposer("), source.indexOf("function paintGamesSource("));
  expect(composer).toContain("writeGamesSelection(sel);\n      clearGamesResults();");
  const tray = source.slice(source.indexOf("function bindGamesSource("), source.indexOf("// Scout source: the SAME shared"));
  // One clear for the external-username unpick, one for the linked account.
  expect(tray.match(/clearGamesResults\(\);/g)).toHaveLength(2);
});
