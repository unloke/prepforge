import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The Teams page is a work surface: the open team's panel takes the height of
// the view and the two short lists beside it keep their own height at the top.
// It used to be the other way round — every card was sized by its content, so
// the page showed three short strips over half a screen of empty ground.
const shared = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const view = readFileSync(new URL("./teams.css", import.meta.url), "utf8");

// The desktop block that turns Teams into a work surface.
const desktop = shared.slice(shared.indexOf("@media (min-width: 1021px) {"));

describe("Teams is a work surface", () => {
  it("gives the grid the height of the view", () => {
    const grid = desktop.slice(desktop.indexOf(".teams {"), desktop.indexOf(".teams {") + 200);
    expect(grid).toMatch(/min-height:\s*100%/);
    expect(grid).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  });

  it("keeps the directory and the incoming shares at their own height", () => {
    expect(shared).toMatch(/\.teams > \.card\.dir,\s*\n\s*\.teams > \.card\.incoming \{ align-self: start; \}/);
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
    // The row under it brings the line.
    expect(view).toMatch(/\.team-row \{[^}]*border-top:\s*1px solid var\(--line\)/);
  });
});
