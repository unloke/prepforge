// Phone audit regression: after a session the mode tabs sat below the board bar,
// and the results card was clipped to its top edge between them.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "phone.css"), "utf8");
const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));

it("the mode tabs leave with the setup card, and Modes leads back to them", () => {
  const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");
  expect(styles).toMatch(/#view-train \.train-sidebar:not\(\[data-session-state="setup"\]\) #train-modes,\n#view-train \.train-sidebar\[data-session-state="setup"\] #train-back \{ display: none; \}/);
  expect(phone).not.toMatch(/data-session-state="setup"\]\) > \.panel-head \{[^}]*order: 5/);
});

it("the result card takes the room the session card had", () => {
  const panel = phone.match(/#view-train \.train-sidebar\[data-session-state="summary"\] > \.panel-scroll \{[^}]*\}/);
  expect(panel).not.toBeNull();
  expect(panel[0]).toMatch(/flex: 1 1 0/);
  expect(panel[0]).toMatch(/min-height: 0/);
  const card = phone.match(/#view-train \.train-sidebar\[data-session-state="summary"\] #train-summary \{[^}]*\}/);
  expect(card).not.toBeNull();
  expect(card[0]).toMatch(/overflow-y: auto/);
  // The finished position is not a live board: it does not hold the strip.
  expect(phone).toMatch(/\.study:has\(\[data-session-state="summary"\]\) \.board-stack \{ display: none/);
});

// Every Train control a thumb reaches is at least 44px tall on a phone. The
// mode tabs were 32, the old mode-name link 17, New session 36, and the blitz switch
// 20. The switch keeps its look and grows an invisible tap area.
it("every Train control is a thumb-sized target on a phone", () => {
  for (const selector of [
    /#view-train #train-modes \.seg-btn \{[^}]*min-height: 44px/,
    /#view-train \.prog-head \{ min-height: 44px/,
    /#view-train #train-back \{[^}]*min-height: 44px/,
    /#view-train #train-fresh \{ min-height: 44px/,
  ]) expect(css.match(selector), selector.source).not.toBeNull();
  // The switch is drawn 26px tall on a phone and its tap area adds 9px above
  // and below: 44px, a thumb's height.
  const size = css.match(/:is\(#train-blitz-toggle, #explorer-engine-toggle\) \{[^}]*height: (\d+)px/);
  const hit = css.match(/:is\(#train-blitz-toggle, #explorer-engine-toggle\)::after \{[^}]*inset: -(\d+)px -\d+px/);
  expect(size, "switch size").not.toBeNull();
  expect(hit, "switch tap area").not.toBeNull();
  expect(Number(size[1]) + 2 * Number(hit[1])).toBeGreaterThanOrEqual(44);
});

// Setting up is a card to read, so Start must be on screen with it. At
// 430x740 the full-width board left the panel 146px and pushed Start's top to
// 785 under a 740px screen: the board yields 400px of height there. The board
// rule is the one formula every other phone board uses — the screen's height
// less the bar and --phone-reserve — and the setup state is what sets that
// token; a hard-coded 400px in the rule overrode the token, so the two values
// could drift apart.
it("keeps the setup card and Start on screen at 430x740", () => {
  const rule = phone.match(/#view-train:has\(\.train-sidebar\[data-session-state="setup"\]\) \.board-stack \{[^}]*\}/);
  expect(rule, "the setup board cap").not.toBeNull();
  expect(rule[0]).toMatch(/width:\s*min\(100vw/);
  expect(rule[0]).toMatch(/var\(--phone-bar-h\)/);
  // One formula: the rule names no height of its own.
  expect(rule[0]).toMatch(/var\(--phone-reserve\)/);
  expect(rule[0]).not.toMatch(/\d+px/);
  // The 400px lives on the state, where it was measured: 285px of reserve
  // leaves Start at 798 on a 740px screen (under the bar), 400px puts it at 683.
  const state = phone.match(/:has\(\.train-sidebar\[data-session-state="setup"\]\) \{ --phone-reserve:[^}]*\}/);
  expect(state, "the setup reserve").not.toBeNull();
  expect(state[0]).toMatch(/--phone-reserve:\s*400px/);
});
