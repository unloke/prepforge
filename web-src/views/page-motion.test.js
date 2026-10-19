// The Library and Teams rows are the page's main controls, so they carry
// their own feedback: a hover, a press and a focus ring. A table row cannot
// scale on press the way a button does, so the press reads as a step deeper
// into the surface.
//
// Opening a team brings its members in one after another, and the global
// reduced-motion block drops the travel for anyone who asked for no motion.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "..", "styles.css"), "utf8");
const teams = readFileSync(join(root, "teams.css"), "utf8");

function rule(sheet, selector) {
  const start = sheet.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  const open = sheet.indexOf("{", start);
  return sheet.slice(open, sheet.indexOf("}", open));
}

it("a Library row answers the pointer", () => {
  expect(rule(css, ".lib-row:hover {")).toMatch(/background:\s*var\(--panel-soft\)/);
  expect(rule(css, ".lib-row:active {")).toMatch(/background:\s*var\(--surface-3\)/);
  expect(rule(css, ".lib-row:focus-visible {")).toMatch(/outline/);
  // The fill fades rather than snapping.
  expect(rule(css, ".lib-row {\n  min-height: 54px;")).toMatch(/transition:\s*background-color/);
});

it("a Teams row answers the pointer", () => {
  expect(rule(teams, ".team-row:hover {")).toMatch(/background:\s*var\(--panel-soft\)/);
  expect(rule(teams, ".team-row:active {")).toMatch(/background:\s*var\(--surface-3\)/);
  expect(rule(teams, ".team-row:focus-visible {")).toMatch(/outline/);
  expect(rule(teams, ".team-shared-rep-row:active,")).toMatch(/background:\s*var\(--surface-3\)/);
});

it("an inactive tab brightens under the pointer", () => {
  expect(rule(teams, ".teams .tabs button:hover {")).toMatch(/color:\s*var\(--text\)/);
});

it("the members arrive one after another", () => {
  expect(rule(teams, "#team-members > .mem-row {")).toMatch(/animation:\s*row-enter/);
  expect(rule(teams, "#team-members > .mem-row:nth-child(2) {")).toMatch(/animation-delay:\s*60ms/);
  expect(rule(teams, "#team-members > .mem-row:nth-child(n + 4) {")).toMatch(/animation-delay:\s*180ms/);
});

it("reduced motion drops the travel everywhere", () => {
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {", css.indexOf("@media (prefers-reduced-motion: reduce) {") + 10));
  expect(block).toMatch(/animation-duration:\s*0\.001ms !important/);
  expect(block).toMatch(/transition-duration:\s*0\.001ms !important/);
});
