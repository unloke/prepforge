// The desktop Today strip answers one question — what to study next — in one
// primary line.
//
// It used to be a single row of four 13px grey lines: the queue (the number the
// Train button turns on) was the third thing the eye found, between a streak and
// two stat lines, and a second line restated the streak the figure beside it
// already showed. Now the queue leads at the strip's own reading size, the rest
// of the queue is one quieter line under it, and the week's history and the
// lifetime counts sit at the far end over the action.
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

it("the queue is the loudest line in the strip", () => {
  const queue = rule(".today-queue {");
  expect(queue).toMatch(/font-size:\s*18px/);
  expect(queue).toMatch(/color:\s*var\(--text\)/);
  // The rest of the queue, the streak and the week's recap are one step quieter,
  // and they are one size: 13px, never a second hierarchy.
  expect(rule(".today-more,\n.today-recap,\n.today-streak {")).toMatch(/font-size:\s*var\(--fs-s\)/);
});

it("the streak is one quiet line with its figure in ink", () => {
  // Tabular so two visits do not shift the strip; the figure is the only ink.
  expect(rule(".today-more b,\n.today-streak b,\n.today-recap b {")).toMatch(/font-variant-numeric:\s*tabular-nums/);
  expect(css).not.toMatch(/\.today-count \{/);
});

it("the week's recap sits at the far end", () => {
  // Right-aligned over the action, so the queue's line runs the width of the
  // strip and the quiet figures close it.
  const aside = rule(".today-aside {");
  expect(aside).toMatch(/align-items:\s*flex-end/);
  expect(aside).toMatch(/text-align:\s*right/);
});
