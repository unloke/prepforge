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

it("the phone stylesheet keeps the compact row geometry", () => {
  // Belt and braces: the chip bump must not have replaced the row rules.
  expect(phone).toMatch(/\.lr \{[\s\S]*?grid-template-columns: 1fr auto/);
});
