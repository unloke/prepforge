import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { createTeamsView } from "./views/teams.js";

// Top-level `createX({ ... })` calls in app.js run while the module evaluates. Passing a
// `const` declared further down throws in dev (TDZ) and hands the controller `undefined`
// in the bundle, so every identifier they take must already be declared.
const lines = readFileSync(new URL("./app.js", import.meta.url), "utf8").split("\n");

function declarationLines() {
  const found = new Map();
  lines.forEach((line, index) => {
    const single = line.match(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (single && !found.has(single[1])) found.set(single[1], index + 1);
    const destructured = line.match(/^(?:export\s+)?(?:const|let)\s+\{([^}]*)\}\s*=/);
    if (destructured) {
      for (const part of destructured[1].split(",")) {
        const name = part.split(":").pop().trim();
        if (name && !found.has(name)) found.set(name, index + 1);
      }
    }
  });
  return found;
}

function topLevelFactoryCalls() {
  const calls = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(?:(?:export\s+)?(?:const|let)\s+[\w${}\s,]+=\s*)?create\w*\(\{/.test(lines[i])) continue;
    let depth = 0;
    let body = "";
    for (let j = i; j < lines.length; j++) {
      body += `${lines[j]}\n`;
      for (const ch of lines[j]) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
      if (depth <= 0) break;
    }
    const args = body.slice(body.indexOf("{"));
    const names = new Set();
    for (const m of args.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}\n])/g)) names.add(m[1]);
    for (const m of args.matchAll(/:\s*([A-Za-z_$][\w$]*)\s*[,\n}]/g)) names.add(m[1]);
    calls.push({ line: i + 1, names });
  }
  return calls;
}

describe("app.js init order", () => {
  it("declares every argument of a top-level controller factory before the call", () => {
    const declared = declarationLines();
    const calls = topLevelFactoryCalls();
    expect(calls.some((call) => call.names.has("hydrateBuild"))).toBe(true);
    const late = [];
    for (const call of calls) {
      for (const name of call.names) {
        const at = declared.get(name);
        if (at && at > call.line) late.push(`${name} (declared line ${at}, used line ${call.line})`);
      }
    }
    expect(late).toEqual([]);
  });
});

// C2: Teams flashed the logged-out state on reload for a signed-in user.
// Cause: a Team view entered while /api/auth/me was still in flight rendered the
// guest copy ("Sign in to create or join a team") and hid the shares card, because
// the code read appState.signedIn as "false" when it was in fact UNKNOWN. The fix
// splits the two: authKnown gates every owner-scoped paint, so an unread session
// shows a neutral loading state and the real one lands when auth resolves.
describe("teams paints nothing owner-scoped until auth is known (C2)", () => {
  function teamsHarness(appState) {
    const elements = new Map();
    const makeEl = (id) => ({
      id,
      dataset: {},
      hidden: false,
      textContent: "",
      _innerHTML: "",
      classList: { _set: new Set(), toggle: () => {}, contains: () => false },
      setAttribute: () => {},
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
      closest: () => null,
      focus: () => {},
      set innerHTML(v) { this._innerHTML = v; },
      get innerHTML() { return this._innerHTML; },
    });
    const byId = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    };
    globalThis.document = {
      getElementById: byId,
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const view = createTeamsView({
      appState,
      api: async () => ({ teams: [] }),
      hideTeamDetail: () => {},
      openTeamDetail: async () => {},
      loadSharedRepertoires: () => {},
      editRepertoire: () => {},
      unshareRepertoireFromTeam: () => {},
      copySharedRepertoire: () => {},
      teamRoleLabel: (r) => r,
    });
    return { view, byId };
  }

  afterEach(() => {
    delete globalThis.document;
  });

  it("holds a loading state, not the guest state, while the session is unread", async () => {
    const { view, byId } = teamsHarness({ signedIn: false, authKnown: false, teams: [] });
    await view.loadTeams();
    expect(String(byId("teams-list").innerHTML)).toContain("Loading");
    expect(String(byId("teams-list").innerHTML)).not.toContain("Loading\u2026\u2026");
    // The guest copy is never painted, so the sign-in button is never revealed by
    // this path either.
    expect(byId("team-empty-title").textContent).toBe("");
    // A list re-render (hideTeamDetail) must not fall through to "No teams yet".
    view.renderTeamsList();
    expect(String(byId("teams-list").innerHTML)).toContain("Loading");
    expect(String(byId("teams-list").innerHTML)).not.toContain("No teams yet");
    expect(byId("team-empty-title").textContent).toBe("");
  });

  it("shows the guest state once a 401 proves the visitor is signed out", async () => {
    const { view, byId } = teamsHarness({ signedIn: false, authKnown: true, teams: [] });
    await view.loadTeams();
    expect(byId("team-empty-signin").hidden).toBe(false);
    expect(String(byId("teams-list").innerHTML)).toBe("");
  });

  it("app.signedIn is only meaningful once auth is known", () => {
    const state = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    expect(state).toMatch(/authKnown: false/);
    // The account controller settles the flag on the first session read, and the
    // Teams list honours it.
    const controller = readFileSync(new URL("./controllers/account.js", import.meta.url), "utf8");
    expect(controller).toMatch(/appState\.authKnown = true/);
    const teams = readFileSync(new URL("./views/teams.js", import.meta.url), "utf8");
    expect(teams).toMatch(/if \(!appState\.authKnown\)/);
  });
});
