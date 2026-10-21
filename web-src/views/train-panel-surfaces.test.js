// Structure comes from space and tone, not from hairlines. The panel's
// surfaces are separated by a step in tone: the coach banner is a soft strip,
// the up-next and the health rows are soft fields, and the cards are not
// boxes at all. The rules that used to draw those lines are gone.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, "styles.css"), "utf8");

const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\n)${escaped} \\{([^}]*)\\}`));
  expect(match, selector).not.toBeNull();
  return match[2];
};

it("the coach banner is a soft strip, not a ruled one", () => {
  expect(rule(".train-coach")).not.toMatch(/border-bottom/);
  expect(rule(".train-coach")).toMatch(/background: var\(--panel-soft\)/);
});

it("the session card is not a box", () => {
  expect(rule("#view-train .tcard")).toMatch(/border: 0/);
  expect(rule("#view-train .tcard > h3")).toMatch(/border-bottom: 0/);
});

it("the up-next is one soft field with the rows spaced inside it", () => {
  expect(rule(".upnext")).toMatch(/background: var\(--panel-soft\)/);
  expect(rule(".upnext")).not.toMatch(/border-top/);
  expect(rule(".un-row")).not.toMatch(/border-bottom/);
});

it("the result card's health rows are one soft field", () => {
  expect(rule(".delta")).toMatch(/background: var\(--panel-soft\)/);
  expect(rule(".tsum-row")).not.toMatch(/border-bottom/);
});
