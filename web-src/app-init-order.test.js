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
    // The skeleton carries no text and no guest copy: aria-hidden bars only.
    expect(String(byId("teams-list").innerHTML)).toContain("is-skeleton");
    expect(String(byId("teams-list").innerHTML)).toContain('aria-hidden="true"');
    expect(String(byId("teams-list").innerHTML)).not.toContain("No teams");
    // The guest copy is never painted, so the sign-in button is never revealed by
    // this path either.
    expect(byId("team-empty-title").textContent).toBe("");
    // A list re-render (hideTeamDetail) must not fall through to "No teams yet".
    view.renderTeamsList();
    expect(String(byId("teams-list").innerHTML)).toContain("is-skeleton");
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
    const state = readFileSync(new URL("./core/state.js", import.meta.url), "utf8");
    expect(state).toMatch(/authKnown: false/);
    // The account controller settles the flag on the first session read, and the
    // Teams list honours it.
    const controller = readFileSync(new URL("./controllers/account.js", import.meta.url), "utf8");
    expect(controller).toMatch(/appState\.authKnown = true/);
    const teams = readFileSync(new URL("./views/teams.js", import.meta.url), "utf8");
    expect(teams).toMatch(/if \(!appState\.authKnown\)/);
  });
});

// Reload flash: boot read `signedIn` as "signed out" while /api/auth/me was still
// in flight, and the static markup's dashboard view painted as the route until
// restoreWorkspaceLocation caught up. Both are app-level (the Teams fix above only
// covered the Teams list), so the hold lives around the whole init.
describe("app boot holds auth-dependent state until the session is known", () => {
  const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const markup = readFileSync(new URL("./index.html", import.meta.url), "utf8");

  it("ships the hold in the markup and shows it before anything else in init()", () => {
    // The hold starts hidden: JS may be slow, but nothing auth-dependent may
    // paint a guess while it is still loading.
    expect(markup).toMatch(/<div[^>]*id="boot-hold"[^>]*\bhidden\b/);
    // Hold FIRST in init(), before the first owner-scoped call: not just before
    // the view switch — the whole workspace must paint against the real session.
    const showAt = src.indexOf("holdBootView();");
    expect(showAt).toBeGreaterThan(-1);
    const initAt = src.indexOf("async function init() {");
    const beforeHold = src
      .slice(initAt, showAt)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//") && line !== "async function init() {");
    expect(beforeHold).toEqual([]);
    const authAt = src.indexOf("await refreshAuthStatus();");
    expect(showAt).toBeLessThan(authAt);
  });

  it("reveals the Library once the session is known, and other routes once restored", () => {
    const early = src.indexOf('view === "dashboard") releaseBootView();');
    expect(early).toBeGreaterThan(src.indexOf("await refreshAuthStatus();"));
    expect(early).toBeLessThan(src.indexOf("await loadSignedInWorkspace();"));
    const release = src.indexOf("\n  releaseBootView();");
    const restore = src.indexOf("await restoreWorkspaceLocation();");
    expect(release).toBeGreaterThan(restore);
    // And the reveal happens before the sign-in return / shared view land, so a
    // boot failure or a late overlay never leaves the hold in the DOM.
    expect(release).toBeLessThan(src.indexOf("await resumeAfterSignIn("));
    // A thrown boot must not strand the hold: the views underneath are honest.
    expect(src).toMatch(/\.catch\(\(error\) => \{\s*releaseBootView\(\);/);
  });

  it("keeps the URL's route rather than the markup default", () => {
    // restoreWorkspaceLocation reads the hash and switches to it; the markup's
    // view-dashboard default is only the paint under the hold.
    expect(src).toMatch(/const loc = parseWorkspaceLocation\(window\.location\.href\);/);
    expect(src).toMatch(/switchView\(loc\.view, \{ fromUrl: true \}\);/);
  });

  it("holds the account chip too: an unread session is not a signed-out one", () => {
    const chip = readFileSync(new URL("./controllers/account.js", import.meta.url), "utf8");
    expect(chip).toMatch(/else if \(!appState\.authKnown\) \{/);
    // The page guest marker is copy that only applies signed out.
    expect(chip).toMatch(/toggle\("is-guest", appState\.authKnown === true && !appState\.signedIn\)/);
  });

  function bootHoldHarness() {
    const removed = [];
    const el = { hidden: true, remove: () => removed.push("boot-hold") };
    const document = { getElementById: (id) => (id === "boot-hold" ? el : null) };
    const compiled = new Function("document", [
      "let bootHold = null;",
      "let bootHeld = false;",
      src.slice(src.indexOf("function holdBootView() {"), src.indexOf("async function restoreWorkspaceLocation(")),
      "return { holdBootView, releaseBootView, isHeld: () => bootHeld };",
    ].join("\n"))(document);
    return { ...compiled, el, removed };
  }

  it("the hold covers boot and is removed, not just hidden, once", () => {
    const { holdBootView, releaseBootView, isHeld, el, removed } = bootHoldHarness();
    // Nothing before JS runs: the markup ships it hidden.
    expect(el.hidden).toBe(true);
    holdBootView();
    expect(el.hidden).toBe(false);
    expect(isHeld()).toBe(true);
    releaseBootView();
    // Removed, so the workspace underneath is a real subtree and nothing stale
    // can be revealed by a later class change.
    expect(removed).toEqual(["boot-hold"]);
    expect(isHeld()).toBe(false);
    // A second release (the catch path after the happy path) is a no-op.
    releaseBootView();
    expect(removed).toEqual(["boot-hold"]);
  });

  it("with no hold element the workspace is never signalled as held", () => {
    const compiled = new Function("document", [
      "let bootHold = null;",
      "let bootHeld = false;",
      src.slice(src.indexOf("function holdBootView() {"), src.indexOf("async function restoreWorkspaceLocation(")),
      "return { holdBootView, releaseBootView, isHeld: () => bootHeld };",
    ].join("\n"))({ getElementById: () => null });
    compiled.holdBootView();
    expect(compiled.isHeld()).toBe(false);
    compiled.releaseBootView();
    expect(compiled.isHeld()).toBe(false);
  });
});

// Cold boot read the Library twice: loadSignedInWorkspace loads it, then
// restoreWorkspaceLocation switches to the URL's view — and for the default
// route that view IS the dashboard, so switchView ran the whole load again
// (/api/dashboard + /api/repertoires + /api/teams, measured 66 ms apart).
describe("switchView does not re-read a view it is already on", () => {
  const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");

  function dashboardBranch() {
    const start = src.indexOf('  if (name === "dashboard") {');
    const end = src.indexOf("// Entering Teams (re)loads", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("skips the refresh when a boot restore re-enters the current view", () => {
    // switchView remembers the view it is leaving, and the dashboard branch
    // guards the reload on it: fromUrl && previousView === name is the boot
    // restore of the route loadSignedInWorkspace already loaded.
    expect(src).toMatch(/const previousView = appState\.currentView;/);
    expect(dashboardBranch()).toMatch(
      /if \(appState\.signedIn && !\(fromUrl && previousView === name\)\) \{/,
    );
  });

  it("still refreshes on a real arrival and on a Library tab click", () => {
    const branch = dashboardBranch();
    // The guard is on the signed-in refresh only: a click passes fromUrl false
    // and an arrival from another view passes a different previousView, so both
    // reach settleBuildOutbox → loadDashboard.
    expect(branch).toMatch(/settleBuildOutbox\(\)\.then\(\(\) => loadDashboard\(\)\)/);
    expect(branch).toMatch(/ensureDashboardView\(\)\.catch\(\(\) => \{\}\);/);
  });
});
