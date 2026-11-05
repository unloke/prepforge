// The phone's one bottom button. The owner asked for "last game" and "past
// analyses" behind a single control at the bottom of the screen, the way an
// earlier phone layout had them; the sheet behind it is that button.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cssSource } from "./test-styles-source.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const entry = readFileSync(new URL("./phone-entry.js", import.meta.url), "utf8");
const phone = cssSource("phone.css");
const css = phone.slice(phone.lastIndexOf("@media (max-width: 760px)"));
const chart = cssSource("views/analyze-chart.css");

const sheet = html.slice(html.indexOf('id="analyze-open"'), html.indexOf('id="view-build"'));

it("puts Last game and Recent analyses behind the one button", () => {
  // One control raises the sheet; the two actions are rows inside it.
  expect(html).toContain('data-sheet-open="analyze-open"');
  expect(sheet).toMatch(/data-mirror="#fetch-my-game"[^>]*>.*?Last game/s);
  expect(sheet).toMatch(/data-reveal="#history-drawer"[^>]*>.*?Recent analyses/s);
  // Nothing else on the phone raises a game picker.
  expect(html.match(/data-sheet-open="analyze-open"/g)).toHaveLength(1);
});

it("opens each list in place instead of lowering the sheet", () => {
  // A [data-reveal] row toggles the drawer it names and stays in the sheet.
  expect(entry).toMatch(/\[data-reveal\]/);
  expect(entry).toMatch(/target\.open = !target\.open;/);
  // Its own summary would name the action a second time under the row.
  expect(chart).toMatch(/#analyze-open > \.drawer > summary \{ display: none; \}/);
  expect(chart).toMatch(/#analyze-open > \.drawer:not\(\[open\]\) \{ display: none; \}/);
});

it("keeps the sheet's rows an iOS list row (44px, the thumb's hit height)", () => {
  const row = css.match(/\.sheet-row \{[^}]*\}/);
  expect(row).not.toBeNull();
  expect(row[0]).toMatch(/min-height: 44px/);
});
