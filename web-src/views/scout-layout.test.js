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

it("on a phone the engine offer follows the report once there is one", () => {
  const phone = readFileSync(join(root, "..", "phone.css"), "utf8");
  expect(phone).toMatch(/\.scout-panel:has\(#scout-results:not\(:empty\)\) \.scout-main > \[data-unlock-place="scout"\] \{ order: 2; \}/);
});

// The identity is one line above the tabs, and the engine status takes no height
// in that line: on the desktop it sits over the tabs' row, out of the flow.
it("on a phone the docked Start gives way to the toolbar once there is a report", () => {
  const phone = readFileSync(join(root, "..", "phone.css"), "utf8");
  // "A report" is the colour sections; an error block alone keeps the docked Start.
  // :has() cannot nest, so the test is written as one level of :has.
  expect(phone).toMatch(/\.scout-panel:has\(#scout-results > \.scout-section\) > \.toolbar > #scout-btn \{\s*position: static;/);
  // Games and Scout share the pages' 44px title row (it docks as the nav bar).
  expect(phone).not.toMatch(/\.scout-panel > \.page-head \{ min-height: 0; \}/);
  expect(phone).toMatch(/#view-replay \.review > section > \.page-head \{ display: flex; \}/);
});
