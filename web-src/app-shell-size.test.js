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
  it("stays under the size ceiling", () => {
    // 3600 code lines: the shell was 7,300 before the split and is ~2,000 now.
    // The headroom is for wiring a new view (its loader, its nav entry, its
    // boot call) — a view's own code belongs in its module.
    expect(effectiveLines(app)).toBeLessThan(3600);
  });

  it("has no view implementation in it", () => {
    // A view's own render/markup code lives with the view; the shell may load
    // it and switch to it, never paint it.
    expect(app).not.toMatch(/function render(ReplayResults|AnalysisTree|BuilderTree|LibraryRow)/);
    expect(app).not.toMatch(/function (createAccountController|createSettingsActions)\(/);
  });
});
