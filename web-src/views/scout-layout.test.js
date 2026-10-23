// Scout's layout rules, read from its stylesheet.
//
// The failed-source block used to fill with the danger tint, and its retry
// button sat in the middle of the row because nothing pushed it to the end.
// These checks keep that fixed.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "scout.css"), "utf8");

// The body of a rule, matched on the selector itself.
function rule(selector) {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

it("a failed source is a panel block with a red edge, not a red slab", () => {
  const error = rule(".scout-error");
  expect(error).toMatch(/background:\s*var\(--panel\)/);
  expect(error).not.toMatch(/danger-soft/);
  expect(error).toMatch(/border-left:\s*2px solid var\(--danger\)/);
});

it("the retry action sits at the end of the error row", () => {
  expect(rule(".scout-error .btn")).toMatch(/margin-left:\s*auto/);
});

it("the activity trend spans the chart row; the two cards beside it share a row", () => {
  expect(rule(".scout-intel-charts")).toMatch(/repeat\(2,/);
  expect(rule(".scout-intel-trends")).toMatch(/grid-column:\s*1 \/ -1/);
});
