// The Library is a work surface: on a desktop the table card takes the height
// it is given instead of floating as a short card over empty ground.
//
// It used to stop at the last row, so a page with three repertoires showed a
// table in the top third and half a screen of nothing. The setup checklist is
// a short list beside it and keeps its own height. These rules pin that split
// so a density pass cannot turn the page back into a floating card.
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

// The desktop block that turns the Library into a work surface. The sheet has
// one desktop media query per view, so take the one that holds the grid rule.
const gridRule = css.indexOf(".lib-grid { flex: 1 1 auto");
const desktop = css.slice(css.lastIndexOf("@media (min-width: 1021px) {", gridRule));

it("the Library grid takes the height it is given", () => {
  const grid = desktop.slice(desktop.indexOf(".lib-grid {"), desktop.indexOf(".lib-grid {") + 200);
  expect(grid).toMatch(/flex:\s*1 1 auto/);
  expect(grid).toMatch(/align-items:\s*stretch/);
});

it("the setup checklist keeps its own height beside the table", () => {
  const steps = rule(".lib-grid > .steps {");
  expect(steps).toMatch(/align-self:\s*start/);
  // On an empty library there is no table, so the checklist may grow.
  expect(rule(".lib-grid:has(> .lib-list.is-empty:not(.is-error)) > .steps {")).toMatch(/align-self:\s*stretch/);
});
