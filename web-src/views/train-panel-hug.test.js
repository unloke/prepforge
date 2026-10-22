// The Train panel is only as tall as what it holds. Stretched to the board's
// height it showed ~400px of blank panel under the last row in setup, in
// session and on the result card, which reads as content that failed to load.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");

it("the desktop panel ends at its content instead of stretching to the board", () => {
  const desktop = css.match(/@media \(min-width: 1101px\)[^{]*\{\s*#view-train \.train-sidebar \{[^}]*\}\s*\}/);
  expect(desktop, "desktop Train panel rule").not.toBeNull();
  expect(desktop[0]).toMatch(/height: auto/);
  expect(desktop[0]).toMatch(/align-self: start/);
  // Long setup screens (Practice game's pickers) still stop at the viewport
  // and scroll inside: the cap lives on the unconditional rule.
  const base = css.match(/#view-train \.train-sidebar \{[^}]*\}/);
  expect(base[0]).toMatch(/max-height: var\(--study-h\)/);
});

// The queue's source rows are a small table: a name, one meter column and one
// number column, the same x on every row. With the last column sized `auto`
// each row's meter started wherever its own text ended (7px apart at 768px).
it("the source rows share their meter and count columns", () => {
  const row = css.match(/\.train-source \{[^}]*\}/);
  expect(row[0]).toMatch(/grid-template-columns: auto minmax\(0, 1fr\) 72px \d+px/);
});
