// The desktop Today strip is one band: the queue leads, the week's history
// sits in its own cell at the right, and the Train button closes it.
//
// It used to be a grid of three columns whose middle column held four
// stacked lines: the note, the queue, the counts and the recap. The queue -
// the number the Train button turns on - was the second line at 13px, and
// the card kept a hole the width of the window between the text and the
// button. These rules pin the band so a density pass cannot stack it again.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "..", "styles.css"), "utf8");

// The rule body for a selector, matched at the start of a line so an
// id-scoped variant cannot be picked up by accident.
function rule(selector) {
  const start = css.search(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

it("the Today strip is one row, not a grid of stacked columns", () => {
  const strip = rule(".today {");
  expect(strip).toMatch(/display:\s*flex/);
  expect(strip).not.toMatch(/display:\s*grid/);
  // The body is a column of its own: the queue over the note.
  expect(rule(".today-body {")).toMatch(/flex-direction:\s*column/);
});

it("the queue leads the body and the history sits in its own cell", () => {
  // The aside carries the counts and the recap, pushed to the right of the
  // band so the queue is never the second line of a stack.
  const aside = rule(".today-aside {");
  expect(aside).toMatch(/margin-left:\s*auto/);
  expect(aside).toMatch(/flex-direction:\s*column/);
});

it("the queue is the loudest line in the strip", () => {
  expect(rule(".today-queue {")).toMatch(/font-size:\s*16px/);
  expect(rule(".today-queue {")).toMatch(/color:\s*var\(--text\)/);
  // The asides stay quiet: the note, the recap and the counts are 13px.
  expect(rule(".today-note,\n.today-recap {")).toMatch(/font-size:\s*var\(--fs-s\)/);
});
