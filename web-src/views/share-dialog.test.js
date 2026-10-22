import { describe, expect, it, vi } from "vitest";

import { runShareDialog, shareDialogBodyHtml, shareDialogModel } from "./share-dialog.js";

const STATE = {
  repertoire_id: "r1",
  link: { share_enabled: false, share_role: "view", share_rev: 0 },
  grants: [
    { team_id: "t1", name: "Club", role: "edit" },
    { user_id: "u1", name: "Kim", lichess_username: "kimchess", role: "view" },
  ],
};
const LINK_ON = { ...STATE, link: { share_enabled: true, share_role: "copy", share_rev: 1, url: "/?shared=tok" } };
const TEAMS = [{ id: "t1", name: "Club" }, { id: "t2", name: "Juniors" }];

describe("share dialog model and markup", () => {
  it("lists every grant with its role and offers only teams not yet shared", () => {
    const model = shareDialogModel({ name: "KP", state: STATE, teams: TEAMS });
    expect(model.grants).toEqual([
      { key: "team:t1", name: "Club", sub: "Team", role: "edit" },
      { key: "user:u1", name: "Kim", sub: "kimchess", role: "view" },
    ]);
    expect(model.teams).toEqual([{ value: "team:t2", label: "Juniors" }]);
    expect(model.link).toEqual({ on: false, role: "view", url: null });
  });

  it("renders a role select per grant and the link only while it is on", () => {
    const off = String(shareDialogBodyHtml(shareDialogModel({ name: "KP", state: STATE, teams: TEAMS })));
    expect(off).toContain("Share “KP”");
    expect(off).toMatch(/data-grant-role="team:t1"[^>]*>.*<option value="edit" selected>Can edit<\/option>/s);
    expect(off).toContain('aria-checked="false"');
    expect(off).not.toContain("data-link-url");
    expect(off).not.toContain("Reset link");
    const on = String(shareDialogBodyHtml(shareDialogModel({ name: "KP", state: LINK_ON, origin: "https://pf.test" })));
    expect(on).toContain('value="https://pf.test/?shared=tok"');
    expect(on).toContain('<option value="copy" selected>Can copy</option>');
    // The link can be view or copy; never edit.
    expect(on.match(/data-link-role[^]*?<\/select>/)[0]).not.toContain('value="edit"');
    expect(on).toContain("Reset link");
  });

  it("has no team picker when the owner is in no team", () => {
    const markup = String(shareDialogBodyHtml(shareDialogModel({ name: "KP", state: STATE, teams: [] })));
    expect(markup).not.toContain("data-share-target");
  });
});

function fakeUi(actions) {
  const renders = [];
  return {
    renders,
    render: (model) => renders.push(model),
    nextAction: vi.fn(async () => actions.shift() ?? null),
    selectUrl: vi.fn(),
    close: vi.fn(),
  };
}

function deps(ui, overrides = {}) {
  return {
    name: "KP",
    api: vi.fn(async () => STATE),
    postJson: vi.fn(async () => STATE),
    origin: "https://pf.test",
    copyText: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    setStatus: vi.fn(),
    setStatusError: vi.fn(),
    loadTeams: async () => TEAMS,
    ui,
    ...overrides,
  };
}

describe("runShareDialog", () => {
  it("shares with a person, a team, changes a role and removes access", async () => {
    const ui = fakeUi([
      { type: "add", target: "", person: " kim@x.test ", role: "copy" },
      { type: "add", target: "team:t2", person: "", role: "edit" },
      { type: "role", key: "user:u1", role: "edit" },
      { type: "remove", key: "team:t1" },
      { type: "done" },
    ]);
    const d = deps(ui);
    expect(await runShareDialog("r1", d)).toBe(true);
    expect(d.postJson.mock.calls).toEqual([
      ["/api/repertoires/access", { repertoire_id: "r1", person: "kim@x.test", role: "copy" }],
      ["/api/repertoires/access", { repertoire_id: "r1", team_id: "t2", role: "edit" }],
      ["/api/repertoires/access", { repertoire_id: "r1", user_id: "u1", role: "edit" }],
      ["/api/repertoires/access/revoke", { repertoire_id: "r1", team_id: "t1" }],
    ]);
    expect(ui.close).toHaveBeenCalled();
  });

  it("keeps the draft and shows the server's reason when a person is not found", async () => {
    const ui = fakeUi([{ type: "add", target: "", person: "nobody", role: "edit" }, null]);
    const d = deps(ui, {
      postJson: vi.fn(async () => {
        throw new Error("No PrepForge account has that email or Lichess username.");
      }),
    });
    expect(await runShareDialog("r1", d)).toBe(false);
    const last = ui.renders.at(-1);
    expect(last.error).toBe("No PrepForge account has that email or Lichess username.");
    expect(last.draft).toEqual({ target: "", person: "nobody", role: "edit" });
  });

  it("asks for a name instead of sending an empty person", async () => {
    const ui = fakeUi([{ type: "add", target: "", person: "  ", role: "view" }, null]);
    const d = deps(ui);
    await runShareDialog("r1", d);
    expect(d.postJson).not.toHaveBeenCalled();
    expect(ui.renders.at(-1).error).toBe("Enter an email or Lichess username");
  });

  it("turns the link on at its role and copies it, changes its role, and resets it after a confirm", async () => {
    const ui = fakeUi([{ type: "link" }, { type: "link-role", role: "copy" }, { type: "rotate" }, null]);
    const states = [STATE, LINK_ON, LINK_ON, LINK_ON];
    const d = deps(ui, { api: vi.fn(async () => states.shift()) });
    await runShareDialog("r1", d);
    expect(d.postJson.mock.calls.map(([path, body]) => [path, body])).toEqual([
      ["/api/repertoires/share-link", { repertoire_id: "r1", role: "view" }],
      ["/api/repertoires/share-link", { repertoire_id: "r1", role: "copy" }],
      ["/api/repertoires/share-link/rotate", { repertoire_id: "r1" }],
    ]);
    expect(d.copyText).toHaveBeenCalledWith("https://pf.test/?shared=tok");
    expect(d.confirm).toHaveBeenCalledTimes(1);
  });

  it("turns the link off only after a confirm", async () => {
    const ui = fakeUi([{ type: "link" }, { type: "link" }, null]);
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const d = deps(ui, { api: vi.fn(async () => LINK_ON), confirm });
    await runShareDialog("r1", d);
    expect(d.postJson.mock.calls).toEqual([["/api/repertoires/share-link/revoke", { repertoire_id: "r1" }]]);
  });

  it("selects the link for a manual copy when the clipboard is blocked", async () => {
    const ui = fakeUi([{ type: "copy" }, null]);
    const d = deps(ui, { api: vi.fn(async () => LINK_ON), copyText: vi.fn(async () => { throw new Error("blocked"); }) });
    await runShareDialog("r1", d);
    expect(ui.selectUrl).toHaveBeenCalled();
  });

  it("closes and reports when the owner's access state can't be read", async () => {
    const ui = fakeUi([]);
    const d = deps(ui, { api: vi.fn(async () => { throw new Error("Only the owner can do this."); }) });
    expect(await runShareDialog("r1", d)).toBe(false);
    expect(d.setStatusError).toHaveBeenCalledWith("Only the owner can do this.");
    expect(ui.renders).toEqual([]);
  });
});
