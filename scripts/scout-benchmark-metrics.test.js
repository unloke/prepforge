import { describe, expect, it } from "vitest";
import { pressureMetrics } from "./scout-benchmark-metrics.mjs";

describe("Scout offline pressure metrics", () => {
  it("rewards sustained pressure and quantifies alternate replies", () => {
    const result = pressureMetrics([0.56, 0.57, 0.58, 0.60, 0.61, 0.62], "black", [[
      { probability: 0.7, userWdl: 0.58 },
      { probability: 0.3, userWdl: 0.47 },
    ]]);
    expect(result.pressureFloor).toBeCloseTo(0.56);
    expect(result.pressureConsistency).toBe(1);
    expect(result.meanRobustness).toBeCloseTo(0.7);
    expect(result.robustnessFloor).toBeCloseTo(0.7);
  });

  it("gives each decision position equal weight and exposes the weak floor", () => {
    const result = pressureMetrics([0.5, 0.5, 0.5, 0.5], "white", [
      [{ probability: 0.9, userWdl: 0.6 }],
      [{ probability: 0.1, userWdl: 0.4 }],
    ]);
    expect(result.meanRobustness).toBeCloseTo(0.5);
    expect(result.robustnessFloor).toBe(0);
  });

  it("flags a late opponent mistake when earlier positions were neutral", () => {
    const result = pressureMetrics([0.5, 0.5, 0.5, 0.82, 0.83, 0.84], "black");
    expect(result.pressureFloor).toBe(0.5);
    expect(result.pressureConsistency).toBeCloseTo(1 / 3);
    expect(result.largestOpponentBlunderGain).toBeCloseTo(0.32);
    expect(result.blunderDependency).toBeCloseTo(0.32 / 0.34);
    expect(result.meanRobustness).toBeNull();
    expect(result.robustnessFloor).toBeNull();
  });
});
