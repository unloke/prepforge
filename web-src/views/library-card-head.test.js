// The Library's card head draws no rule of its own.
//
// The head sat a line above the table's column header, so the table carried
// two lines in a row where one was meant. The column header under it brings
// the line; the head does not.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "..", "styles.css"), "utf8");

// The rule body for a selector, starting at its first occurrence.
function rule(selector) {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

it("the Library head leaves the line to the table", () => {
  expect(rule(".lib .card-head {")).not.toMatch(/border-bottom/);
  // The column header under it brings the line.
  expect(rule(".lib-cols {")).toMatch(/border-bottom:\s*1px solid var\(--line\)/);
});
