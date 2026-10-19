// Phone audit regression: after a session the mode tabs and the board bar sat
// below the results card in the layout order, so the card was clipped to its
// top edge between them.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "phone.css"), "utf8");
const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));

it("a live session or a result card reads from the top, above the mode tabs", () => {
  const tabs = phone.match(/#view-train \.train-sidebar:not\(\[data-session-state="setup"\]\) > \.panel-head \{[^}]*\}/);
  expect(tabs).not.toBeNull();
  expect(tabs[0]).toMatch(/order: 5/);
});

it("the result screen scrolls instead of clipping the card", () => {
  const rule = phone.match(/#view-train \.train-sidebar\[data-session-state="summary"\] > \.panel-scroll \{[^}]*\}/);
  expect(rule).not.toBeNull();
  expect(rule[0]).toMatch(/overflow-y: auto/);
});
