import { describe, expect, it } from "vitest";
import { opponentMoveProbability } from "./scout-probability.js";

describe("sample-aware opponent probabilities", () => {
  it("distinguishes sparse certainty from strong and weak evidence", () => {
    expect(opponentMoveProbability(1, 1, "jeffreys")).toBe(0.75);
    expect(opponentMoveProbability(2, 2, "jeffreys")).toBeCloseTo(2.5 / 3);
    expect(opponentMoveProbability(1, 2, "jeffreys")).toBe(0.5);
    expect(opponentMoveProbability(24, 37, "jeffreys")).toBeCloseTo(24.5 / 38);
    expect(opponentMoveProbability(1, 37, "jeffreys")).toBeCloseTo(1.5 / 38);
    expect(opponentMoveProbability(1, 37, "jeffreys")).toBeLessThan(0.1);
  });
});
