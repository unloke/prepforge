import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { inviteDialogBodyHtml, inviteDialogModel } from "./team-invite.js";

// Teams on a phone (round 2): the open team is a pushed screen with a nav bar
// (back · name · ⋯), its other actions in a sheet that mirrors the desktop
// controls, and the pane's one primary docked above the tab bar. The invite
// dialog keeps one row of link actions with Done in its title bar.

vi.mock("../core/api.js", () => ({ api: vi.fn(), currentOwnerId: () => "u1", postJson: vi.fn(), setStatus: vi.fn(), setStatusError: vi.fn() }));
vi.mock("../core/state.js", () => ({ appState: { teams: [], selectedTeamId: "t1", accountUserId: "u1" } }));
vi.mock("../core/modals.js", () => ({ showConfirmModal: vi.fn(), showInputModal: vi.fn() }));
const { createTeamsController } = await import("./teams-controller.js");

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./teams.css", import.meta.url), "utf8");
const view = html.slice(html.indexOf('id="view-teams"'), html.indexOf('id="view-settings"'));
const phone = css.slice(css.indexOf("@media (max-width: 760px)"));

describe("the open team's ⋯ sheet", () => {
  it("mirrors the desktop controls it replaces", () => {
    const sheet = view.slice(view.indexOf('id="team-actions"'), view.indexOf("</div>\n            </div>", view.indexOf('id="team-actions"')));
    for (const target of ["#team-add-member", "#team-detail-rename", "#team-detail-delete", "#team-members .team-remove[data-self='1']"]) {
      expect(sheet).toContain(`data-mirror="${target}"`);
    }
    expect(view).toContain('data-sheet-open="team-actions"');
    // New team rides the page title, as New repertoire does on Library; Invite docks at the thumb.
    expect(view).toContain('class="page-head-btn" data-mirror="#teams-new"');
    expect(view).toContain('class="btn primary team-invite-cta" id="team-invite-cta" data-mirror="#team-detail-invite"');
  });

  it("shows only the rows whose control this role has, and drops ⋯ with none", () => {
    const targets = { "#team-add-member": { hidden: true }, "#team-detail-rename": { hidden: false }, "#team-detail-delete": { hidden: true } };
    const rows = Object.keys(targets).concat("#team-members .team-remove[data-self='1']").map((mirror) => ({ dataset: { mirror }, hidden: false }));
    const more = { hidden: false };
    globalThis.document = {
      getElementById: (id) => (id === "team-detail-more" ? more : null),
      querySelectorAll: (sel) => (sel === "#team-actions [data-mirror]" ? rows : []),
      querySelector: (sel) => targets[sel] || null,
    };
    const teams = createTeamsController({});
    teams.syncTeamActions();
    expect(rows.map((r) => r.hidden)).toEqual([true, false, true, true]);
    expect(more.hidden).toBe(false);
    targets["#team-detail-rename"].hidden = true;
    teams.syncTeamActions();
    expect(more.hidden).toBe(true);
  });
});

describe("phone composition", () => {
  it("docks the pane's one action above the tab bar and keeps the head one row", () => {
    expect(phone).toMatch(/\.team-detail \.sub-head \{\s*position: fixed;[^}]*bottom: calc\(var\(--phone-bar-h\)/);
    expect(phone).toMatch(/\.team-detail > \.card-head \{\s*display: grid;\s*grid-template-columns: 44px minmax\(0, 1fr\) 44px;/);
    expect(phone).toMatch(/\.team-title h2 \{[^}]*white-space: nowrap;/);
  });
});

describe("invite dialog", () => {
  it("closes from its title bar and keeps the footer to one row of link actions", () => {
    for (const [status, url] of [[{ exists: false }, null], [{ exists: true }, null], [{ exists: true }, "https://app.test/?join=X"]]) {
      const body = String(inviteDialogBodyHtml(inviteDialogModel({ status, url })));
      const title = body.slice(body.indexOf('class="modal-title"'), body.indexOf("</div>"));
      expect(title).toMatch(/class="invite-done" data-action="done"/);
      const footer = body.slice(body.indexOf('class="modal-footer"'));
      expect(footer.match(/class="btn primary"/g)).toHaveLength(1);
    }
    expect(css).toMatch(/\.invite-modal \.modal-footer \{ flex-wrap: nowrap; \}/);
    expect(css).toMatch(/\.invite-modal \.modal-footer \[data-action="done"\] \{ display: none; \}/);
  });
});
