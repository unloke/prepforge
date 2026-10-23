// The Library card ends at its last row.
//
// The table card used to be told to take the height it was given, so a page
// with three repertoires showed them in the top third and about 70% of the card
// was empty white below them; the setup checklist beside it ended far short, so
// the row of cards finished ragged as well. A list is not a work surface: it
// sizes to its rows. The one case that still needs a floor is the empty library,
// whose card centres the first-run invitation.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "..", "styles.css"), "utf8");

// The body of a rule, matched on the selector itself so a longer selector
// that merely contains it (".lib-grid > .steps") is not picked up.
function rule(selector) {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

// The desktop block that lays the Library out. The sheet has one desktop media
// query per view, so take the one that holds the grid rule.
const gridRule = css.indexOf(".lib-grid { align-items: start");
const desktop = css.slice(css.lastIndexOf("@media (min-width: 1021px) {", gridRule));

it("the Library grid sizes to its rows", () => {
  // No flex growth: the card is as tall as the table in it.
  const grid = desktop.slice(desktop.indexOf(".lib-grid {"), desktop.indexOf(".lib-grid {") + 200);
  expect(grid).toMatch(/align-items:\s*start/);
  expect(grid).not.toMatch(/flex:\s*1 1 auto/);
  expect(desktop).not.toMatch(/\.lib \{ min-height: 100% \}/);
});

it("the empty library's card is its invitation, not a floor", () => {
  // The card had a 320px floor and then a 236px one; both held a blank band
  // under the invitation (102px, then 48px). The invitation is the card's only
  // content, so the card is its height.
  expect(css).not.toMatch(/\.lib-list\.is-empty:not\(\.is-error\)\) > \.lib-list \{ min-height/);
});

it("the checklist's rows stay a list on an empty library", () => {
  // The rows used to grow to fill the card, which spread three steps over
  // half a screen of white with a metre of nothing between them.
  const step = rule(".lib-grid:has(> .lib-list.is-empty:not(.is-error)) .step {");
  expect(step).toMatch(/flex:\s*0 0 auto/);
  expect(step).not.toMatch(/max-height/);
});

it("the error card stands where the empty card stands", () => {
  // Both are the only thing in the list card, so both stand in the middle of
  // it. The error used to float at the top with the whole surface empty under
  // it, while the empty state beside it sat in the middle.
  expect(rule(".lib-grid:has(> .lib-list.is-empty) > .lib-list {")).toMatch(/display:\s*flex/);
  expect(rule(".lib-list.is-empty > .lib-rep-list {")).toMatch(/justify-content:\s*center/);
});
