// Games on a phone docks one action above the tab bar. With no source there is
// nothing to check, so a disabled Check games must not hold the dock: the next
// step (Link Lichess account, or Sign in) takes it instead.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../phone.css", import.meta.url), "utf8");

function rule(selector) {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

it("Check games leaves the dock while there is no source", () => {
  expect(rule("#view-replay .games-panel > .toolbar:has(#games-source-chips:empty, .src-chip-signin) > #lichess-compare-btn")).toMatch(/display:\s*none/);
});

it("the source's next step docks as the page's filled action", () => {
  const chip = rule("#view-replay.is-active .games-panel:not([hidden]) .src-chip.src-chip-signin {");
  expect(chip).toMatch(/position:\s*fixed/);
  expect(chip).toMatch(/bottom:\s*calc\(var\(--phone-bar-h\) \+ env\(safe-area-inset-bottom\) \+ 12px\)/);
  expect(chip).toMatch(/height:\s*44px/);
  expect(chip).toMatch(/background:\s*var\(--accent\)/);
});
