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

it("Library phone controls meet the 40px tap-target floor", () => {
  for (const selector of [
    "#view-dashboard .lib-list .seg-btn",
    "#view-dashboard .today .btn.lg",
    "#view-dashboard .step .btn",
  ]) {
    const body = rule(selector);
    expect(body, selector).toMatch(/min-height:\s*40px/);
    expect(body, selector).toMatch(/height:\s*40px/);
  }
  const dismiss = rule("#view-dashboard .steps .setup-dismiss");
  expect(dismiss).toMatch(/width:\s*40px/);
  expect(dismiss).toMatch(/height:\s*40px/);
});
