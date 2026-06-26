// Tests for the logical (non-arbitrary) Scout candidate cut.
//
// Phase 1: trimRankedBranches replaces the hard slice(0, 300) with a prior-signal
// trim — keep prior-ordered branches above the pure-noise floor, always keep at
// least minKeep so the Maia backup pool stays full, never exceed the pathological
// ceiling. These tests pin the contract; the implementation must satisfy them.

import { describe, expect, it } from "vitest";

import {
  SCOUT_BRANCH_HARD_CEILING,
  SCOUT_BRANCH_MIN_KEEP,
  SCOUT_PRIOR_NOISE_FLOOR,
  trimRankedBranches,
} from "./scout.js";

// Build a prior-sorted branch list (desc) with the given priors.
function branchesWithPriors(priors) {
  return priors.map((p, i) => ({
    line: `u${i}`,
    ucis: [`u${i}`],
    sans: [`m${i}`],
    exploitabilityPrior: p,
    games: 1,
  }));
}

describe("trimRankedBranches (Phase 1 logical pre-engine cut)", () => {
  it("exports a noise floor and min-keep that are sane constants", () => {
    expect(SCOUT_PRIOR_NOISE_FLOOR).toBeGreaterThan(0);
    // The floor must sit below the prior of any branch with a reproducible (n>=3) prefix
    // (~0.119) so it only drops non-reproducible, modal one-offs.
    expect(SCOUT_PRIOR_NOISE_FLOOR).toBeLessThan(0.119);
    expect(SCOUT_BRANCH_MIN_KEEP).toBeGreaterThanOrEqual(48);
  });

  it("drops only branches at/below the noise floor", () => {
    // 70 strong branches, then a tail at/below the floor.
    const priors = [
      ...Array.from({ length: 70 }, (_, i) => 0.3 - i * 0.001),
      ...Array.from({ length: 40 }, () => SCOUT_PRIOR_NOISE_FLOOR / 2),
    ];
    const kept = trimRankedBranches(branchesWithPriors(priors));
    // The 40 sub-floor one-offs are dropped; the 70 real branches survive.
    expect(kept).toHaveLength(70);
    expect(kept.every((b) => b.exploitabilityPrior > SCOUT_PRIOR_NOISE_FLOOR)).toBe(true);
  });

  it("always keeps at least minKeep even when most branches are sub-floor", () => {
    // Only 5 above-floor branches, but a long sub-floor tail.
    const priors = [
      ...Array.from({ length: 5 }, () => 0.3),
      ...Array.from({ length: 200 }, () => SCOUT_PRIOR_NOISE_FLOOR / 2),
    ];
    const kept = trimRankedBranches(branchesWithPriors(priors));
    expect(kept).toHaveLength(SCOUT_BRANCH_MIN_KEEP);
  });

  it("never returns more than the pathological ceiling", () => {
    const priors = Array.from({ length: SCOUT_BRANCH_HARD_CEILING + 150 }, () => 0.25);
    const kept = trimRankedBranches(branchesWithPriors(priors));
    expect(kept).toHaveLength(SCOUT_BRANCH_HARD_CEILING);
  });

  it("preserves prior order and is a prefix slice of the input", () => {
    const priors = Array.from({ length: 100 }, (_, i) => 0.5 - i * 0.004);
    const input = branchesWithPriors(priors);
    const kept = trimRankedBranches(input);
    kept.forEach((b, i) => expect(b).toBe(input[i]));
  });

  it("handles empty and missing-prior inputs without throwing", () => {
    expect(trimRankedBranches([])).toEqual([]);
    expect(trimRankedBranches(undefined)).toEqual([]);
    // Missing prior treated as 0 (sub-floor) but min-keep still applies.
    const kept = trimRankedBranches([{ line: "a", ucis: ["a"] }]);
    expect(kept).toHaveLength(1);
  });
});
