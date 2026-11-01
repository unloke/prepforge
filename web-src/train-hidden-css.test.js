// Regression for the 2026-10-01 walkthrough and the 2026-10-08 phone audit:
// view rules (`.qbar { display: flex }`, phone.css's progress panel) beat the
// UA [hidden] rule and left stale panels on screen. One global rule wins.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eagerCss as css } from "./test-styles-source.js";

const root = dirname(fileURLToPath(import.meta.url));

it("a hidden element is never displayed, whatever a view's display rule says", () => {
  expect(css).toMatch(/^\[hidden\] \{ display: none !important; \}$/m);
});
