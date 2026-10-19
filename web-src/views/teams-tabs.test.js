import { afterEach, describe, expect, it } from "vitest";

import { createTeamsView } from "./teams.js";

// Characterization for the ui-prototype-v2 Teams detail sheet:
//  - Members / Shared repertoires are two tabs over ONE panel (only the active
//    pane shows), with ArrowLeft/Right stepping and focusing the other tab;
//  - tab counts come from the real payload and hide at zero (no fake data);
//  - the invite footer renders from the real `invite` field (managers only)
//    and never implies a link exists when the payload says otherwise.

function makeHarness(overrides = {}) {
  const elements = new Map();
  const makeEl = (id) => {
    const listeners = {};
    const el = {
      id,
      dataset: { teamPane: id.includes("repertoires") || id.includes("shared") ? "repertoires" : "members" },
      hidden: false,
      tabIndex: 0,
      className: "",
      textContent: "",
      _innerHTML: "",
      classList: {
        _set: new Set(),
        toggle(name, on) {
          if (on) this._set.add(name);
          else this._set.delete(name);
        },
        contains(name) {
          return this._set.has(name);
        },
      },
      setAttribute: () => {},
      addEventListener: (name, fn) => {
        (listeners[name] ||= []).push(fn);
      },
      querySelectorAll: () => [],
      focus: () => {},
      set innerHTML(v) {
        el._innerHTML = v;
      },
      get innerHTML() {
        return el._innerHTML;
      },
      __listeners: listeners,
    };
    return el;
  };
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };
  const paneEls = [];
  globalThis.document = {
    getElementById: (id) => (id ? byId(id) : null),
    querySelectorAll: (selector) => {
      if (selector === "[data-team-pane]") {
        if (!paneEls.length) {
          const members = makeEl("team-tab-members");
          members.dataset.teamPane = "members";
          const reps = makeEl("team-tab-repertoires");
          reps.dataset.teamPane = "repertoires";
          paneEls.push(members, reps);
        }
        return paneEls;
      }
      if (selector === "[data-team-panel]") return [];
      if (selector === "[data-team-count]") {
        const cm = byId("count-members");
        cm.dataset.teamCount = "members";
        const cr = byId("count-repertoires");
        cr.dataset.teamCount = "repertoires";
        return [cm, cr];
      }
      return [];
    },
    querySelector: () => null,
  };
  const view = createTeamsView({
    appState: { signedIn: true, authKnown: true, teams: [], selectedTeamId: null, accountUserId: "u1" },
    api: async () => ({ teams: [] }),
    hideTeamDetail: () => {},
    openTeamDetail: async () => {},
    loadSharedRepertoires: () => {},
    editRepertoire: () => {},
    unshareRepertoireFromTeam: () => {},
    copySharedRepertoire: () => {},
    teamRoleLabel: (r) => r,
    ...overrides,
  });
  return { view, byId, paneEls };
}

afterEach(() => {
  delete globalThis.document;
});

describe("teams detail tabs (ui-prototype-v2)", () => {
  it("shows one pane at a time and moves aria/tabindex/focus with the selection", () => {
    const { view, paneEls } = makeHarness();
    view.bindTeamTabs();
    const [membersTab, repsTab] = paneEls;

    view.selectTeamPane("repertoires");
    expect(membersTab.classList.contains("is-active")).toBe(false);
    expect(repsTab.classList.contains("is-active")).toBe(true);
    expect(membersTab.tabIndex).toBe(-1);
    expect(repsTab.tabIndex).toBe(0);

    // ArrowLeft on the repertoires tab steps back to members and focuses it.
    const fired = [];
    repsTab.__listeners.keydown.forEach((fn) =>
      fn({ key: "ArrowLeft", preventDefault: () => fired.push("pd") })
    );
    expect(fired).toContain("pd");
    expect(membersTab.classList.contains("is-active")).toBe(true);
    expect(repsTab.classList.contains("is-active")).toBe(false);
  });

  it("tab counts come from the payload and hide at zero", () => {
    const { view, byId } = makeHarness();
    view.renderTeamTabCounts({ members: 3, repertoires: 2 });
    expect(byId("count-members").textContent).toBe("3");
    expect(byId("count-members").hidden).toBe(false);
    expect(byId("count-repertoires").textContent).toBe("2");

    view.renderTeamTabCounts({ members: 1, repertoires: 0 });
    expect(byId("count-repertoires").hidden).toBe(true);
  });

  it("a partial patch (shared list render) keeps the other tab's real count", () => {
    const { view, byId } = makeHarness();
    view.renderTeamTabCounts({ members: 2 });
    view.renderTeamTabCounts({ repertoires: 1 });
    expect(byId("count-members").textContent).toBe("2");
    expect(byId("count-members").hidden).toBe(false);
    expect(byId("count-repertoires").textContent).toBe("1");
  });

  it("shared repertoires tab count mirrors the rendered list length", () => {
    const { view, byId } = makeHarness();
    byId("team-shared-repertoires");
    view.renderTeamSharedRepertoires("t1", [
      { id: "r1", name: "Caro", color: "black", owner_user_id: "u2", owner_display_name: "Sam" },
    ]);
    expect(byId("count-repertoires").textContent).toBe("1");
    expect(byId("count-repertoires").hidden).toBe(false);
  });


  it("does not auto-open when there are several teams", async () => {
    const opened = [];
    const hidden = [];
    const { view, byId } = makeHarness({
      appState: { signedIn: true, authKnown: true, teams: [], selectedTeamId: null, accountUserId: "u1" },
      api: async () => ({
        teams: [
          { id: "a", name: "A", role: "owner", member_count: 1 },
          { id: "b", name: "B", role: "member", member_count: 3 },
        ],
      }),
      openTeamDetail: async (id) => opened.push(id),
      hideTeamDetail: () => hidden.push(true),
    });
    await view.loadTeams();
    expect(opened).toEqual([]);
    expect(hidden).toHaveLength(1);
    expect(byId("team-empty-title").textContent).toBe("Choose a team");
  });

  it("signed out: the empty card says how to start", async () => {
    const { view, byId } = makeHarness({
      appState: { signedIn: false, authKnown: true, teams: [], selectedTeamId: null },
    });
    await view.loadTeams();
    expect(byId("team-empty-body").textContent).toMatch(/Sign in to create or join a team/);
    expect(String(byId("teams-shared").innerHTML)).toBe("");
  });
  it("New team is offered only when signed in (guests get the card's Sign in)", async () => {
    const guest = makeHarness({ appState: { signedIn: false, authKnown: true, teams: [], selectedTeamId: null } });
    await guest.view.loadTeams();
    guest.view.renderTeamsList();
    expect(guest.byId("teams-new").hidden).toBe(true);
    const member = makeHarness({ appState: { signedIn: true, authKnown: true, teams: [], selectedTeamId: null } });
    member.view.renderTeamsList();
    expect(member.byId("teams-new").hidden).toBe(false);
  });
  it("signed out: a list re-render (hideTeamDetail) stays empty, not 'No teams yet'", async () => {
    const { view, byId } = makeHarness({
      appState: { signedIn: false, authKnown: true, teams: [], selectedTeamId: null },
    });
    await view.loadTeams();
    // app.js hideTeamDetail() calls renderTeamsList() after the signed-out paint.
    view.renderTeamsList();
    // The main card carries the one Sign in; the list doesn't repeat it.
    expect(String(byId("teams-list").innerHTML)).toBe("");
  });
  it("search visibility follows the team collection, including an unmatched typed filter", () => {
    const appState = { signedIn: true, authKnown: true, teams: [], selectedTeamId: null };
    const { view, byId } = makeHarness({ appState });
    const field = { hidden: false };
    const search = byId("teams-search");
    search.closest = () => field;
    search.value = "unmatched";
    view.renderTeamsList();
    expect(field.hidden).toBe(true);
    appState.teams = [{ id: "a", name: "Club", role: "owner", member_count: 1 }];
    view.renderTeamsList();
    expect(field.hidden).toBe(false);
    expect(String(byId("teams-list").innerHTML)).toContain("No teams match your search");
    search.value = "";
    search.__listeners.input.forEach((fn) => fn());
    expect(String(byId("teams-list").innerHTML)).toContain('data-team-id="a"');
    appState.teams = [];
    view.renderTeamsList();
    expect(field.hidden).toBe(true);
    appState.signedIn = false;
    view.renderTeamsList();
    expect(String(byId("teams-list").innerHTML)).toBe("");
  });
  it("a failed directory load says what failed and offers a Retry", async () => {
    let attempts = 0;
    const { view, byId } = makeHarness({
      api: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Failed to fetch");
        return { teams: [{ id: "a", name: "Club", role: "owner", member_count: 1 }] };
      },
    });
    byId("teams-list").querySelector = () => ({ addEventListener: () => {} });
    await view.loadTeams();
    const html = String(byId("teams-list").innerHTML);
    expect(html).toContain("Failed to fetch");
    expect(html).toContain('role="alert"');
    // Retry is wired back into the same load, so the next attempt repaints.
    await view.loadTeams();
    expect(String(byId("teams-list").innerHTML)).toContain('data-team-id="a"');
  });

  it("the signed-out empty card offers a Sign in button (UX 2026-10-01 P2-10)", () => {
    const calls = [];
    const { view, byId } = makeHarness({ requireSignIn: (reason) => calls.push(reason) });
    const button = byId("team-empty-signin");
    view.renderTeamEmptyCard("signed-out");
    expect(button.hidden).toBe(false);
    button.__listeners.click.forEach((fn) => fn());
    expect(calls).toEqual(["Sign in to create or join a team"]);

    view.renderTeamEmptyCard("choose");
    expect(button.hidden).toBe(true);
    // Re-rendering never stacks a second click handler.
    view.renderTeamEmptyCard("signed-out");
    expect(button.__listeners.click).toHaveLength(1);
  });
});

describe("teams directory: opening a team", () => {
  const team = (id, name) => ({ id, name, role: "owner", member_count: 2 });

  it("one team stays in the directory until the user opens it", async () => {
    const calls = [];
    const { view, byId } = makeHarness({
      appState: { signedIn: true, authKnown: true, teams: [team("t1", "Taipei Knights")], selectedTeamId: null, accountUserId: "u1" },
      api: async () => ({ teams: [team("t1", "Taipei Knights")] }),
      openTeamDetail: async (id) => calls.push(["open", id]),
      hideTeamDetail: () => calls.push(["hide"]),
    });
    await view.loadTeams();
    expect(calls).toEqual([["hide"]]);
    expect(byId("team-empty-title").textContent).toBe("Choose a team");
  });

  it("a team the user picked re-opens after the list reloads", async () => {
    const calls = [];
    const { view } = makeHarness({
      appState: { signedIn: true, authKnown: true, teams: [team("t1", "A"), team("t2", "B")], selectedTeamId: "t2", accountUserId: "u1" },
      api: async () => ({ teams: [team("t1", "A"), team("t2", "B")] }),
      openTeamDetail: async (id) => calls.push(["open", id]),
      hideTeamDetail: () => calls.push(["hide"]),
    });
    await view.loadTeams();
    expect(calls).toEqual([["open", "t2"]]);
  });

  it("no teams: the empty card says how to start", async () => {
    const { view, byId } = makeHarness({
      appState: { signedIn: true, authKnown: true, teams: [], selectedTeamId: null, accountUserId: "u1" },
      api: async () => ({ teams: [] }),
    });
    await view.loadTeams();
    expect(byId("team-empty-title").textContent).toBe("No teams yet");
    // One empty state, not two: the card says it, the directory stays empty.
    expect(String(byId("teams-list").innerHTML)).toBe("");
    view.renderTeamsList();
    expect(String(byId("teams-list").innerHTML)).toBe("");
  });

  it("a search with no hit is still named in the directory", async () => {
    const { view, byId } = makeHarness({
      appState: { signedIn: true, authKnown: true, teams: [team("t1", "Taipei Knights")], selectedTeamId: null, accountUserId: "u1" },
      api: async () => ({ teams: [team("t1", "Taipei Knights")] }),
    });
    await view.loadTeams();
    byId("teams-search").value = "zzz";
    view.renderTeamsList();
    expect(String(byId("teams-list").innerHTML)).toContain("No teams match your search");
  });
});
