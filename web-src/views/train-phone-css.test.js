// Train on a phone: Home and Result are pages (no board, the tab bar stays), a
// Session pins the board with the coach line under it and the board bar's
// action slot at the thumb. One state attribute, #view-train[data-train-screen],
// drives all of it: no positional selectors, no second state machine.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../phone.css", import.meta.url), "utf8");
const phone = css.slice(css.indexOf("/* ---- Train: Home and Result are pages"), css.indexOf("/* ---- Menus: action sheets"));

it("Home and Result are pages: no board, no thumb bar, the tab bar stays", () => {
  expect(phone).toContain('#view-train:is([data-train-screen="home"], [data-train-screen="result"]) :is(.board-stack, .board-bar, .blitz-bar) { display: none; }');
  expect(phone).toMatch(/body:has\(#view-train\.is-active:is\(\[data-train-screen="home"\], \[data-train-screen="result"\]\)\) \.tabbar \{[^}]*visibility: visible;/);
});

it("is driven by the screen attribute alone", () => {
  expect(css).not.toContain("data-session-state");
  expect(css).not.toContain("data-play-live");
  expect(phone).not.toMatch(/:nth-(last-)?child/);
  // Controls that do not apply are absent, never kept as invisible space.
  expect(phone).not.toMatch(/visibility: hidden/);
});

it("the board bar's action slot sits at the thumb in the same two cells for drills and games", () => {
  expect(css).toMatch(/\.study \.board-bar :is\(#analysis-prev, #build-parent, #train-hint\) \{ order: 5; grid-column: -3 \/ -2; \}/);
  expect(css).toMatch(/\.study \.board-bar :is\(#analysis-next, #build-next, #train-skip\) \{ order: 6; grid-column: -2 \/ -1; \}/);
  expect(phone).toContain(".study .board-bar #play-takeback { order: 5; grid-column: -3 / -2; }");
  expect(phone).toContain(".study .board-bar #play-resign { order: 6; grid-column: -2 / -1; }");
});

// Every Train control a thumb reaches is at least 44px tall on a phone; chips
// and the colour switch are 40px with the row's padding around them.
it("every Train control is a thumb-sized target on a phone", () => {
  for (const selector of [
    /#view-train \.train-back \{ min-height: 44px; height: 44px; \}/,
    /#view-train \.train-row-go \{ height: 44px; min-height: 44px; \}/,
    /#view-train \.train-summary-actions \.btn \{ height: 46px; min-height: 46px; \}/,
    /\.train-pick \{ min-height: 48px;/,
  ]) expect(phone.match(selector), selector.source).not.toBeNull();
  // The switch is one shared control: a 34x20 track at every width with a
  // shared tap area that adds 12px above and below, so 44px is reached without
  // Train redrawing it.
  const shared = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const hit = shared.match(/\.pf-switch::after \{[^}]*inset: -(\d+)px/);
  const track = shared.match(/--switch-h:\s*(\d+)px/);
  expect(Number(track[1]) + 2 * Number(hit[1])).toBeGreaterThanOrEqual(44);
  expect(css).not.toMatch(/#train-blitz-toggle, #explorer-engine-toggle\) \{/);
});

it("the pickers open as a bottom sheet at the thumb", () => {
  const sheet = phone.match(/\.train-picker \{[^}]*\}/)[0];
  expect(sheet).toMatch(/top: auto/);
  expect(sheet).toMatch(/bottom: calc\(8px \+ env\(safe-area-inset-bottom\)\)/);
  expect(sheet).toMatch(/max-height: 70dvh/);
});

it("the result cells share one row on a phone instead of orphaning the last", () => {
  expect(phone).toContain(":root .sum-cells { grid-template-columns: repeat(auto-fit, minmax(68px, 1fr)); }");
});
