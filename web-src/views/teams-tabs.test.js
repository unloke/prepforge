import { afterEach, describe, expect, it } from "vitest";

import { createTeamsView } from "./teams.js";

// Characterization for the ui-prototype-v2 Teams detail sheet:
//  - Members / Shared repertoires are two tabs over ONE panel (only the active
//    pane shows), with ArrowLeft/Right stepping and focusing the other tab;
//  - tab counts come from the real payload and hide at zero (no fake data);
//  - the invite footer renders from the real `invite` field (managers only)
//    and never implies a link exists when the payload says otherwise.

function makeHarness() {
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
    appState: { signedIn: true, teams: [], selectedTeamId: null, accountUserId: "u1" },
    api: async () => ({ teams: [] }),
    escapeHtml: (s) => String(s),
    hideTeamDetail: () => {},
    openTeamDetail: async () => {},
    loadSharedRepertoires: () => {},
    editRepertoire: () => {},
    unshareRepertoireFromTeam: () => {},
    copySharedRepertoire: () => {},
    teamRoleLabel: (r) => r,
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

  it("invite footer renders from the real invite field and hides otherwise", () => {
    const { view, byId } = makeHarness();
    const foot = byId("team-invite-foot");

    view.renderTeamInviteFooter({ invite: { exists: false } });
    expect(foot.hidden).toBe(true);

    view.renderTeamInviteFooter({ invite: { exists: true, created_at: "2026-09-01T00:00:00Z", expires_at: null } });
    expect(foot.hidden).toBe(false);
    expect(foot.innerHTML).toContain("Invite link active");
    expect(foot.innerHTML).toContain("revoke from Invite");
    expect(foot.innerHTML).not.toContain("expires");

    view.renderTeamInviteFooter({ invite: { exists: true, expires_at: "2030-10-04T00:00:00Z" } });
    expect(foot.innerHTML).toContain("expires");
    expect(foot.innerHTML).not.toContain("· revoke from Invite ·");
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
});
