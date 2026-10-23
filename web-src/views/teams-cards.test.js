import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The Teams page is a work surface: the pane on the right takes the height of
// the view whether a team is open or not, and the two lists (directory,
// incoming shares) stack beside it at their own height. A placeholder that
// stopped 250px down left most of the window as bare ground.
const shared = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const view = readFileSync(new URL("./teams.css", import.meta.url), "utf8");

// The desktop block that composes Teams.
const desktop = shared.slice(shared.indexOf("@media (min-width: 1021px) {\n  .teams {"));

describe("Teams is a work surface", () => {
  it("gives the grid the height of the view", () => {
    expect(desktop).toMatch(/\.teams \{ grid-template-columns: 300px minmax\(0, 1fr\); grid-template-rows: auto minmax\(0, 1fr\); min-height: 100%; \}/);
    expect(desktop).toMatch(/\.teams:has\(> \.team-detail:not\(\[hidden\]\)\) \{ grid-template-rows: auto minmax\(0, 1fr\); \}/);
  });

  it("stacks the directory and the incoming shares in one column beside the team", () => {
    expect(desktop).toMatch(/\.teams > \.card\.dir,\s*\n\s*\.teams > \.card\.incoming \{ grid-column: 1; align-self: start; \}/);
    expect(desktop).toMatch(/\.teams > \.team-empty \{ grid-column: 2; grid-row: 1 \/ span 2; align-self: stretch; \}/);
  });

  it("makes the first-run panel the pane, not a short card under the title", () => {
    expect(desktop).toMatch(/\[data-empty="no-teams"\], \[data-empty="signed-out"\]\) > \.team-empty \{ grid-column: 1; grid-row: 1 \/ -1; align-self: stretch; \}/);
  });

  it("turns the placeholder into the first-run panel when there is no team yet", () => {
    expect(desktop).toMatch(/\[data-empty="no-teams"\][^{]*> \.card\.dir \{ display: none; \}/);
    expect(desktop).toMatch(/\.teams\[data-empty="no-teams"\] #team-empty-new \{ display: inline-flex; \}/);
  });

  it("lets the open team's panel fill the card", () => {
    expect(shared).toMatch(/\.teams > \.team-detail:not\(\[hidden\]\) \{ display: flex; flex-direction: column; \}/);
    expect(shared).toMatch(/\[data-team-panel\] \{ flex: 1 1 auto; min-height: 0; overflow: auto; \}/);
  });

  it("centres the empty state in the card it fills", () => {
    const empty = view.slice(view.indexOf(".teams .team-empty {"), view.indexOf(".teams .team-empty {") + 200);
    expect(empty).toMatch(/justify-content:\s*center/);
  });

  it("keeps the side cards' content at the top", () => {
    const card = view.match(/\.teams \.card \{[^}]*\}/);
    expect(card).toBeTruthy();
    expect(card[0]).not.toMatch(/display:\s*(flex|grid)/);
  });

  it("leaves the line under a head to the row beneath it", () => {
    // The head's own rule landed on the first row's rule, drawing two lines
    // in the same place.
    const head = view.match(/\.teams \.card-head \{[^}]*\}/);
    expect(head).toBeTruthy();
    expect(head[0]).not.toMatch(/border-bottom/);
    // The row under it brings the line, as a table rule inside the marked
    // list (the way the replay ledger and the scout lines keep theirs).
    expect(view).toMatch(/#teams-list\[data-ui\] \.team-row \{ border-top:\s*1px solid var\(--line\); \}/);
  });

  it("keeps a rule only where an interface fragment owns it", () => {
    // The tab strip and the invite footer carried lines of their own; each
    // carries a fill instead, and the active tab's underline is the only rule
    // left in the strip.
    expect(view.match(/\.teams \.tabs \{[^}]*\}/)[0]).not.toMatch(/border-bottom/);
    expect(view.match(/\.team-invite-foot \{[^}]*\}/)[0]).not.toMatch(/border-top/);
    // The member rows keep theirs, inside the marked list.
    expect(view).toMatch(/#team-members\[data-ui\] > \.mem-row,\s*\n\s*#team-shared-repertoires\[data-ui\] > \.mem-row \{ border-top:\s*1px solid var\(--line\); \}/);
  });
});

describe("share role pill", () => {
  it("draws nothing when the share carries no role label", () => {
    expect(shared).toMatch(/:is\([^)]*\.team-role-badge[^)]*\):empty \{ display: none; \}/);
  });
});
