// Regression for the 2026-10-01 walkthrough and the 2026-10-08 phone audit:
// view rules (`.qbar { display: flex }`, phone.css's progress panel) beat the
// UA [hidden] rule and left stale panels on screen. One global rule wins.
import { expect, it } from "vitest";
import { eagerCss as css } from "./test-styles-source.js";

it("a hidden element is never displayed, whatever a view's display rule says", () => {
  expect(css).toMatch(/^\[hidden\] \{ display: none !important; \}$/m);
});
