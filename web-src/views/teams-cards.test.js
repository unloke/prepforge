import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The Teams page is a grid of three cards; with no teams the directory is short
// and the middle empty card was the tallest, so the row looked ragged. Every
// card stretches to the row, its own content still sitting at the top.
const shared = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const view = readFileSync(new URL("./teams.css", import.meta.url), "utf8");

describe("Teams columns share one height", () => {
  it("stretches each card to the grid row", () => {
    expect(shared).toMatch(/\.teams > \.card \{ align-self: stretch; \}/);
  });

  it("keeps each card's content at its top", () => {
    expect(view).toMatch(/\.teams \.card \{[^}]*\}/);
    expect(view.match(/\.teams \.card \{[^}]*\}/)[0]).not.toMatch(/display:\s*(flex|grid)/);
  });
});
