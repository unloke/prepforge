// The eval chart's readout (web-src/views/analyze-readout.js): the tooltip says
// "left prep" on the ply where the game left preparation, and nowhere else.
import { describe, expect, it } from "vitest";

import { evalChartTooltipHtml } from "./analyze-readout.js";

const POINT = { ply: 5, san: "Bb5", score_cp: 40, bounded_score_cp: 40, classification: "good" };

describe("eval chart readout", () => {
  it("says left prep on the departure ply only", () => {
    expect(String(evalChartTooltipHtml(POINT, { leftPrep: true }))).toContain(" · left prep");
    expect(String(evalChartTooltipHtml(POINT, { leftPrep: false }))).not.toContain("left prep");
    expect(String(evalChartTooltipHtml(POINT))).not.toContain("left prep");
  });

  it("keeps the current-move mark after the prep mark", () => {
    const text = String(evalChartTooltipHtml(POINT, { leftPrep: true, isCurrent: true }));
    expect(text.indexOf("left prep")).toBeLessThan(text.indexOf("current"));
  });
});
