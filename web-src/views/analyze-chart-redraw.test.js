import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ANALYZE_SOURCE = readFileSync(new URL("./analyze.js", import.meta.url), "utf8");

// Drawing the chart must not move the board. The chart redraws whenever its box
// changes size; a redraw that called showAnalysisPly() to read the ply navigated to
// the mainline instead, and a branch restored after a reload was lost.
describe("eval chart redraw", () => {
  it("never calls showAnalysisPly while drawing", () => {
    const body = ANALYZE_SOURCE.slice(ANALYZE_SOURCE.indexOf("function renderEvalChart("), ANALYZE_SOURCE.indexOf("function renderAnalysis("));
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/showAnalysisPly\(\)/);
  });
});
