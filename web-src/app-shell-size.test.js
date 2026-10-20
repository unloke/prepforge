import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The size ceiling's point is that app.js is the app shell only. This pins the
// measured result of the split, so a later change that starts stacking code back
// into the shell fails here with the number rather than passing quietly.
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function effectiveLines(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks.split("\n").filter((line) => {
    const text = line.trim();
    return text.length > 0 && !text.startsWith("//");
  }).length;
}

describe("app.js is the shell", () => {
  it("matches the size recorded in the eslint override", () => {
    // eslint.config.js carries this file's ceiling (a file still over 500 may
    // not grow). If app.js shrinks, lower that number here and there together:
    // this test is what keeps the override from quietly becoming generous.
    const config = readFileSync(new URL("../eslint.config.js", import.meta.url), "utf8");
    const recorded = Number(config.match(/"web-src\/app\.js", (\d+)/)[1]);
    // eslint's own count is the authority (it parses comments properly); a
    // rough count here only has to agree that the file is not creeping up.
    expect(effectiveLines(app)).toBeLessThanOrEqual(recorded);
    expect(effectiveLines(app)).toBeGreaterThan(recorded * 0.95);
  });

  it("has no view implementation in it", () => {
    // A view's own render/markup code lives with the view; the shell may load
    // it and switch to it, never paint it.
    expect(app).not.toMatch(/function render(ReplayResults|AnalysisTree|BuilderTree|LibraryRow)/);
    expect(app).not.toMatch(/function (createAccountController|createSettingsActions)\(/);
  });
});
