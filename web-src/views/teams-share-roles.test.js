import { beforeEach, describe, expect, it, vi } from "vitest";

// A team share's role, changed by the repertoire's owner on the Teams page:
// the row shows the new role at once; a failed write puts the old one back.

const calls = vi.hoisted(() => ({ post: [], status: [], errors: [], fail: false }));
vi.mock("../core/api.js", () => ({
  api: vi.fn(),
  currentOwnerId: () => "u1",
  postJson: vi.fn(async (path, body) => {
    calls.post.push({ path, body });
    if (calls.fail) throw new Error("Only the owner can do this.");
    return {};
  }),
  setStatus: (text) => calls.status.push(text),
  setStatusError: (text) => calls.errors.push(text),
}));
vi.mock("../core/state.js", () => ({ appState: { teams: [], selectedTeamId: "t1", accountUserId: "u1" } }));
vi.mock("../core/modals.js", () => ({ showConfirmModal: vi.fn(), showInputModal: vi.fn() }));

const { createTeamsController } = await import("./teams-controller.js");

function setup() {
  globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };
  const teams = createTeamsController({});
  const list = [{ id: "r1", name: "KP", color: "white", owner_user_id: "u1", role: "view" }];
  teams.renderTeamSharedRepertoires("t1", list);
  return { teams, list };
}

describe("changing a team share's role", () => {
  beforeEach(() => {
    calls.post.length = 0;
    calls.status.length = 0;
    calls.errors.length = 0;
    calls.fail = false;
  });

  it("writes the grant for that team and keeps the new role", async () => {
    const { teams, list } = setup();
    const done = teams.changeTeamShareRole("t1", "r1", "edit");
    expect(list[0].role).toBe("edit"); // optimistic
    await done;
    expect(calls.post).toEqual([
      { path: "/api/repertoires/access", body: { repertoire_id: "r1", team_id: "t1", role: "edit" } },
    ]);
    expect(list[0].role).toBe("edit");
    expect(calls.status.at(-1)).toBe('Team role for "KP": Can edit');
  });

  it("puts the old role back when the server refuses", async () => {
    const { teams, list } = setup();
    calls.fail = true;
    await teams.changeTeamShareRole("t1", "r1", "copy");
    expect(list[0].role).toBe("view");
    expect(calls.errors).toEqual(["Only the owner can do this."]);
  });

  it("runs quick changes in order and skips a no-op", async () => {
    const { teams, list } = setup();
    await Promise.all([teams.changeTeamShareRole("t1", "r1", "copy"), teams.changeTeamShareRole("t1", "r1", "edit")]);
    await teams.changeTeamShareRole("t1", "r1", "edit");
    expect(calls.post.map((c) => c.body.role)).toEqual(["copy", "edit"]);
    expect(list[0].role).toBe("edit");
  });
});
