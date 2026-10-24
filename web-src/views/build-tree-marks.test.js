// Build's tree shows its structure with Build-only classes: a position where
// the opponent has just moved and nothing answers it is a gap, marked with one
// "?" in the negative colour; side lines step back under their fork. The
// shared move-tree rules that Analyze uses are not changed for this.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const build = readFileSync(new URL("./build.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

it("the decorate marks a leaf the opponent has just played as a gap", () => {
  expect(build).toMatch(/const gap = opp && !\(node\.children && node\.children\.length\);/);
  expect(build).toMatch(/if \(gap\) classes\.push\("is-gap"\);/);
});

it("the gap mark is one '?' in the negative colour, scoped to Build's tree", () => {
  const rule = /#builder-tree \.mtree-move\.is-gap::after \{([^}]*)\}/.exec(css);
  expect(rule, "the gap rule").not.toBeNull();
  expect(rule[1]).toMatch(/content:\s*" \?"/);
  expect(rule[1]).toMatch(/var\(--negative\)/);
});

it("side lines and the main line differ in weight under Build's tree", () => {
  expect(css).toMatch(/#builder-tree \.mtree-line\.is-main > \.mtree-move \{[^}]*font-weight: 650;/);
  expect(css).toMatch(/#builder-tree \.mtree-var \.mtree-move \{[^}]*font-weight: 450;/);
});

it("the move menu's ⋯ handle is big enough to read as three dots, not a dash", () => {
  const handle = /\.mtree-move \.mtree-more \{[\s\S]*?\}/.exec(css)[0];
  expect(handle).toMatch(/font-size:\s*14px/);
  expect(handle).toMatch(/width:\s*18px/);
});
