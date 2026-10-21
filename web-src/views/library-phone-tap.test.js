// Library phone tap targets. The 2026-10-01 walkthrough set 44px as the mobile
// target; the Library's own phone controls (filter chips, Today Train, Get
// started dismiss/CTA) were built at 34-36px and measured under the 40px floor
// at 390x660. This pins the phone rules so a later density pass cannot shrink
// them back.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "..", "phone.css"), "utf8");

function rule(selector) {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

it("Library phone controls meet the 44px tap-target floor", () => {
  for (const selector of [
    "#view-dashboard .lib-list .seg-btn",
    "#view-dashboard .today .btn.lg",
    "#view-dashboard .step .btn",
    "#view-dashboard .lib-row .row-menu-btn",
  ]) {
    const body = rule(selector);
    expect(body, selector).toMatch(/height:\s*44px/);
  }
  const dismiss = rule("#view-dashboard .steps .setup-dismiss");
  expect(dismiss).toMatch(/min-width:\s*44px/);
  expect(dismiss).toMatch(/height:\s*44px/);
});

// The two buttons a dead-end Library screen offers — "Clear filter" on a search
// that matches nothing, "Try again" when the list could not load — are
// `.btn.sm`, which the phone block had overridden to 36px. Both are the only way
// out of their state, so both take the floor.
it("the dead-end buttons on the Library are thumb targets", () => {
  const sm = rule(".btn.sm { min-height: 44px; height: 44px; }");
  expect(sm).toMatch(/min-height:\s*44px/);
  expect(sm).toMatch(/height:\s*44px/);
  // Neither is given a smaller box of its own.
  expect(css).not.toMatch(/data-lib-action="clear-filter"[^}]*height:\s*3\dpx/);
});
