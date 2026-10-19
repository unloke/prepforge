// Phone audit regression: the Games outcome chips are the only control that
// narrows the ledger, and the shared `.sum-chip` is 26px tall. The Games
// stylesheet must raise them to a reliable touch target at phone widths.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "replay.css"), "utf8");
const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));

it("the Games outcome chips are a real touch target on a phone", () => {
  expect(phone).toMatch(/\.games-panel \.sum-chip \{[^}]*height: 40px/);
});

it("keeps the Games ledger before the selected detail on a phone", () => {
  expect(phone).toMatch(/\.triage \{ display: flex; flex-direction: column; \}/);
  expect(phone).not.toContain("column-reverse");
});

it("the phone stylesheet keeps the compact row geometry", () => {
  // Belt and braces: the chip bump must not have replaced the row rules.
  expect(phone).toMatch(/\.lr \{[\s\S]*?grid-template-columns: 1fr auto/);
});

it("keeps every readable line in the ledger and detail at 13px or more", () => {
  // The triage text (badges, date line, reasons, move list) was 11–12px.
  expect(css).toMatch(/#view-replay :is\([^)]*\.kind-badge[^)]*\) \{\s*font-size: 13px;/);
  expect(css).toMatch(/\.moveline \{[^}]*font: 13px/);
  expect(css).not.toMatch(/font: 12px\/1\.5 var\(--mono\)/);
});

it("draws the outcome grey at a readable contrast", () => {
  // "No repertoire" sat at 3.5:1 in --none on its own tint.
  expect(css).toMatch(/\.kind-badge\.t-none \{ color: var\(--muted\)/);
  expect(css).toMatch(/\.sum-chip\.t-none \{ color: var\(--muted\)/);
});

it("marks the open row with a bar and a fill, not a resting shadow", () => {
  expect(css).toMatch(/\.lr\.is-open \{[^}]*border-left: 3px solid var\(--accent\)/);
  expect(css).not.toMatch(/\.lr\.is-open \{[^}]*box-shadow/);
});
