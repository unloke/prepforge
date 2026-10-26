// Library phone parity: what the desktop Library shows must be reachable on a
// phone too.
//
// The phone layout hides the Library's header actions, so "Import PGN" had no
// route on a phone at all: the page head's + is New repertoire, and the import
// button lived only in the hidden header. These rules pin the phone layout so a
// later density pass cannot hide the import action again.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "..", "phone.css"), "utf8");

// The rule body for a selector, starting at its first occurrence.
function rule(selector) {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

it("Import PGN stays reachable on a phone", () => {
  // The actions row is shown, not hidden.
  const actions = rule("#view-dashboard .lib-actions {");
  expect(actions).not.toMatch(/display:\s*none/);
  expect(actions).toMatch(/display:\s*flex/);

  // New repertoire keeps the page head's +; import is the action in this row.
  const newRep = rule("#view-dashboard .lib-actions #dashboard-new-rep");
  expect(newRep).toMatch(/display:\s*none/);

  // A 44px target, like the rest of the phone controls.
  const importBtn = rule("#view-dashboard .lib-actions #dashboard-import-pgn");
  expect(importBtn).toMatch(/height:\s*44px/);
});

it("the phone Library header is a grid: chips on top, search and import below", () => {
  const head = rule("#view-dashboard .lib-list .card-head {");
  expect(head).toMatch(/display:\s*grid/);
  expect(head).toMatch(/"filters filters"\s*"search\s+import"/);
  expect(rule("#view-dashboard .lib-list .seg {")).toMatch(/grid-area:\s*filters/);
  expect(rule("#view-dashboard .lib-list .search-field {")).toMatch(/grid-area:\s*search/);
  expect(rule("#view-dashboard .lib-actions {")).toMatch(/grid-area:\s*import/);
});

it("the phone repertoire row keeps the mastery figure", () => {
  // The mastery cell used to be display:none on a phone, so a phone row said
  // nothing about progress even though the desktop row carries a percentage.
  const cell = rule("#view-dashboard .lib-row .lib-cell-mastery {");
  expect(cell).not.toMatch(/display:\s*none/);
  expect(cell).toMatch(/display:\s*flex/);
  // The percentage itself is kept, the bar is not (no room for it).
  expect(rule("#view-dashboard .lib-row .lib-mbar {")).toMatch(/display:\s*none/);
  // The word names the number: the phone has no column header to do it.
  expect(rule("#view-dashboard .lib-row .lib-mastery-word {")).toMatch(/display:\s*(inline|block)/);
});

it("a repertoire keeps its name whole on a phone", () => {
  // The mastery figure (or the untrained note) shared the name's line and cut
  // the name to a few letters. The name owns the first line; the figure closes
  // the queue's line on the right.
  expect(css).toMatch(/grid-template-areas:\s*"rep rep" "queue mastery"/);
  // With no queue chips the note starts at the name's edge, not the dot's.
  expect(rule("#view-dashboard .lib-row:not(:has(.kchip)) .lib-cell-mastery {")).toMatch(/padding-left:\s*38px/);
});

it("the phone checklist shows no step number", () => {
  // A phone hides the finished steps, so the one step left wore a badge
  // reading "2" that pointed at a list the phone never drew.
  expect(rule("#view-dashboard .step .step-n {")).toMatch(/display:\s*none/);
  // The row drops the badge's column so the title gets the width.
  expect(rule("#view-dashboard .step[data-setup-step] {")).toMatch(/grid-template-columns/);
  // A first-run step puts its action under the words instead of beside them.
  expect(rule("#view-dashboard .step:not([data-setup-step]) {")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
});
