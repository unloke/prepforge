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

// A Home row is as tall as what it shows: its optional parts (Maia's download
// row, an error) take the full width when present and leave no empty grid
// track, so no gap is reserved under the chips when they are absent.
it("a Home row reserves no empty track for its optional parts", () => {
  const shell = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "train-shell.css"), "utf8");
  const row = shell.match(/\.train-row \{[^}]*\}/)[0];
  expect(row).toMatch(/grid-template-areas: "text go" "opts opts";/);
  expect(shell).toMatch(/\.train-row > \[data-unlock-place\],\s*\.train-row-error \{[^}]*grid-column: 1 \/ -1;/);
});
