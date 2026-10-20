// The setup checklist's mark column is a checklist, not an index.
//
// A finished step ticks and an open one is an empty ring, the way the rest of
// the app marks an open thing (the repertoire colour dot). A step number
// between two ticks read as two different lists, and the phone shows no
// number at all.
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

it("an open step is an empty ring", () => {
  expect(rule(".step-n {")).toMatch(/border:\s*1\.5px solid var\(--muted\)/);
  // The finished step keeps the disc and drops the ring's edge.
  expect(rule(".step-n.is-done {")).toMatch(/border-color:\s*transparent/);
});
