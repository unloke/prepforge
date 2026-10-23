// The desktop rail's rows. The sheet's icon rail sets a 34-49px pitch and
// needs a 44px target for the pointer; the rail used to stop at 40. Selection
// is the 1px accent line on the rail's edge, so no row needs a filled tile.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

it("gives every rail row a 44px target", () => {
  expect(css).toMatch(/\.rail \.tab,\s*\.rail \.rail-btn,\s*\.rail \.account-btn \{[^}]*height:\s*44px/s);
  expect(css).toMatch(/\.rail-btn \{[^}]*height:\s*44px/s);
});

it("splits the groups with short hairlines instead of labels", () => {
  expect(css).toMatch(/\.rail-sep \{[^}]*width:\s*20px/s);
  expect(css).not.toContain(".nav-group-label");
});
