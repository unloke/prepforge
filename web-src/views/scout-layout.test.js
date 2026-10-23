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

it("the open line is an edge pseudo-element, not a shadow on a button-like row", () => {
  expect(rule(".scout-lines[data-ui] .line-row.is-expanded")).not.toMatch(/box-shadow/);
  expect(rule(".scout-lines[data-ui] .line-row.is-expanded::before")).toMatch(/width:\s*2px/);
});

it("the empty report is one dashed frame on one line, not a centred card", () => {
  const empty = rule(".scout-panel .scout-empty.empty-state.big");
  expect(empty).toMatch(/border:\s*1px dashed/);
  expect(empty).toMatch(/justify-content:\s*flex-start/);
  expect(empty).toMatch(/background:\s*none/);
});

it("the selected colour tab is a 1px accent line as wide as its label", () => {
  expect(rule(".scout-color-tab")).toMatch(/padding:\s*7px 0;/);
  expect(rule(".scout-color-tab")).toMatch(/border-bottom:\s*1px solid transparent/);
  expect(rule(".scout-color-tab.is-active")).toMatch(/border-bottom-color:\s*var\(--accent\)/);
});

// The phone's engine offer waits under the report once there is one, so the
// opponent's lines are the first thing a thumb meets below the controls.
it("on a phone the engine offer follows the report once there is one", () => {
  const phone = readFileSync(join(root, "..", "phone.css"), "utf8");
  expect(phone).toMatch(/\.scout-panel:has\(#scout-results:not\(:empty\)\) \.scout-main > \[data-unlock-place="scout"\] \{ order: 2; \}/);
});

// The identity is one line above the tabs, and the engine status takes no height
// in that line: on the desktop it sits over the tabs' row, out of the flow.
it("the identity is one row and the engine status is out of the flow on desktop", () => {
  expect(rule(".scout-main > .scout-profile")).toMatch(/flex-direction:\s*row/);
  expect(rule(".scout-main > .scout-profile")).toMatch(/background:\s*none/);
  expect(rule(".scout-engine-progress")).toMatch(/position:\s*absolute/);
});

// The ranked lines come first under the colour tabs on the desktop. The
// weak-spot sentence is the table's one-line caption; the reads and the plan's
// first moves and actions come after the table.
it("on desktop the ranked lines come first, the caption is one line above them", () => {
  expect(css).toMatch(/\.color-sec \.plan > \.scout-lines-head,\s*\.color-sec \.plan > \.scout-lines \{ order: 2; \}/);
  expect(css).toMatch(/\.color-sec \.intel > \.scout-intel-headline \{ order: 1;[^}]*font-size: 14px/);
  expect(css).toMatch(/\.color-sec \.intel > \*,\s*\.color-sec \.plan > \* \{ order: 4; \}/);
});

// One Maia offer, as a quiet line with no card frame.
it("the engine offer is a quiet line on the panel ground, not a card", () => {
  const offer = rule('.scout-main > [data-unlock-place="scout"] .unlock');
  expect(offer).toMatch(/background:\s*none/);
  expect(offer).toMatch(/border-radius:\s*0/);
});

// The colour split reads as text in the identity row, not as a chip beside the buttons.
it("the colour split in the identity row is plain text, not a tinted chip", () => {
  const split = rule(".scout-main > .scout-profile .scout-color-rec");
  expect(split).toMatch(/background:\s*none/);
  expect(split).toMatch(/padding:\s*0/);
});
