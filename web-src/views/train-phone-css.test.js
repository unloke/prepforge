// Train on a phone: Home is a page (no board, the tab bar stays) split into a
// Drill and a Practice pane; a Session pins the board under its top bar with
// the coach line under it and a labelled bottom bar; the Result keeps the board. One state attribute, #view-train[data-train-screen],
// drives all of it: no positional selectors, no second state machine.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../phone.css", import.meta.url), "utf8");
const phone = css.slice(css.indexOf("/* ---- Train: Home is a page"), css.indexOf("/* ---- Menus: action sheets"));

it("Home is a page with no board; the Result keeps the final board but no thumb bar; the tab bar stays on both", () => {
  expect(phone).toContain('#view-train[data-train-screen="home"] :is(.board-stack, .board-bar, .blitz-bar),');
  expect(phone).toContain('#view-train[data-train-screen="result"] :is(.board-bar, .blitz-bar) { display: none; }');
  expect(phone).toMatch(/body:has\(#view-train\.is-active:is\(\[data-train-screen="home"\], \[data-train-screen="result"\]\)\) \.tabbar \{[^}]*visibility: visible;/);
});

it("Home splits into Drill and Practice panes, one primary action each", () => {
  expect(phone).toContain('#view-train:not([data-train-pane="play"]) .train-row[data-row="play"],');
  expect(phone).toContain('#view-train[data-train-pane="play"] .train-row:not([data-row="play"]) { display: none; }');
  // Due queue's Start runs across the card's foot; Practice's Play is the filled one beside Random.
  expect(phone).toMatch(/\.train-row\[data-row="smart"\] \{[^}]*grid-template-areas: "text" "opts" "next" "go";/);
  expect(phone).toMatch(/\.train-row\[data-row="play"\] \{[^}]*"lucky go";/);
  expect(phone).toMatch(/\[data-row="play"\] \.train-row-go \{[^}]*background: var\(--accent\)/);
  // Rehearse is one line: the field and its Start.
  expect(phone).toMatch(/\.train-row\[data-row="all_lines"\] \{[^}]*grid-template-areas: "text text" "opts go";/);
  // The desktop rows keep their chips; the tabs, cards and labels are phone-only.
  const shell = readFileSync(new URL("../train-shell.css", import.meta.url), "utf8");
  expect(shell).toContain("#view-train :is(.train-tabs, .train-bots, .train-sec-label) { display: none; }");
});

it("a Session's top bar sits over the board and its bottom bar is four labelled icons", () => {
  expect(phone).toMatch(/#view-train \.train-head \{ order: 0;/);
  expect(phone).toMatch(/#view-train \.board-bar \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  expect(phone).toContain("#view-train .board-bar .board-label { display: none; }");
  expect(phone).toMatch(/#view-train \.board-bar \.bl \{ display: block; font-size: 12px;/);
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

// Every Train control a thumb reaches is 44px tall on a phone: the shared
// tokens (phone.css sets --control-h; .btn.sm follows it) size the back button,
// Lucky, the Maia offer and the result's actions, and the chips read the same
// token, so Train sets no height of its own and no control is 40 or 46.
it("every Train control is a thumb-sized target on a phone", () => {
  const shell = readFileSync(new URL("../train-shell.css", import.meta.url), "utf8");
  expect(css).toMatch(/--control-h: 36px;/); // round 5: the competitors' control size
  expect(shell.match(/\.train-chip \{[^}]*min-height: var\(--control-h\)/)).not.toBeNull();
  expect(shell).not.toMatch(/--train-control/);
  expect(phone).not.toMatch(/#view-train [^{]*\{[^}]*height: (40|46)px/);
  expect(phone.match(/\.train-pick \{ min-height: 48px;/)).not.toBeNull();
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
  expect(phone).not.toContain("sum-cells");
});
