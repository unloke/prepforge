import { describe, expect, it } from "vitest";

import { FEATURE_IDS } from "./scout-bias-features.js";
import {
  benjaminiHochberg,
  cohortStats,
  leaveOneOutZ,
  subjectZ,
  twoSidedPFromZ,
} from "./scout-bias-cohort.js";

const N = FEATURE_IDS.length;

function makeFit(userId, betaOverrides = {}, { converged = true, firing = 50 } = {}) {
  const beta = new Array(N).fill(0);
  const firingCounts = new Array(N).fill(firing);
  for (const [idx, val] of Object.entries(betaOverrides)) {
    beta[Number(idx)] = val;
  }
  return {
    userId,
    n: 1000,
    beta,
    z: beta.map(() => 0),
    se: beta.map(() => 0.1),
    firingCounts,
    converged,
  };
}

describe("benjaminiHochberg", () => {
  it("matches hand-computed pass set (mixed)", () => {
    const pvals = [0.001, 0.04, 0.03, 0.5, 0.02];
    const alpha = 0.05;
    const mask = benjaminiHochberg(pvals, alpha);
    // sorted: 0.001, 0.02, 0.03, 0.04, 0.5 — thresholds 0.01, 0.02, 0.03, 0.04, 0.05
    expect(mask).toEqual([true, true, true, false, true]);
  });

  it("all pass when every p ≤ alpha/m", () => {
    const pvals = [0.001, 0.002, 0.003];
    const mask = benjaminiHochberg(pvals, 0.05);
    expect(mask.every(Boolean)).toBe(true);
  });

  it("none pass when all p large", () => {
    const pvals = [0.2, 0.3, 0.4, 0.5];
    const mask = benjaminiHochberg(pvals, 0.05);
    expect(mask.every((v) => !v)).toBe(true);
  });
});

describe("cohortStats", () => {
  it("respects min-firing and marks insufficient when < 8 usable members", () => {
    const fits = [];
    for (let i = 0; i < 10; i += 1) {
      const firingCounts = new Array(N).fill(50);
      firingCounts[0] = i < 5 ? 10 : 50;
      fits.push({
        userId: `p${i}`,
        beta: new Array(N).fill(0.1 * i),
        firingCounts,
        converged: true,
      });
    }
    const stats = cohortStats(fits, { minFiring: 30, minMembers: 8 });
    expect(stats.insufficient[0]).toBe(true);
    expect(stats.nUsable[0]).toBe(5);
    expect(stats.insufficient[1]).toBe(false);
    expect(stats.nUsable[1]).toBe(10);
    expect(Number.isFinite(stats.means[1])).toBe(true);
    expect(Number.isFinite(stats.sds[1])).toBe(true);
  });

  it("excludes non-converged members", () => {
    const good = makeFit("good", {}, { converged: true });
    const bad = makeFit("bad", {}, { converged: false });
    const fits = [bad, ...Array.from({ length: 7 }, (_, i) => makeFit(`g${i}`))];
    const stats = cohortStats(fits, { minFiring: 30, minMembers: 8 });
    expect(stats.nUsable[0]).toBe(7);
    expect(stats.insufficient[0]).toBe(true);
  });
});

describe("subjectZ", () => {
  it("computes z relative to cohort mean/sd", () => {
    const fits = Array.from({ length: 10 }, (_, i) => makeFit(`p${i}`, { 2: 0.05 * i }));
    const stats = cohortStats(fits, { minFiring: 30, minMembers: 8 });
    const subject = makeFit("subject", { 2: 2.5 });
    const { z } = subjectZ(subject, stats);
    expect(Number.isFinite(z[2])).toBe(true);
    expect(z[2]).toBeGreaterThan(3);
  });
});

describe("twoSidedPFromZ", () => {
  it("z=1.96 → p≈0.05", () => {
    expect(twoSidedPFromZ(1.96)).toBeCloseTo(0.05, 2);
  });
});

describe("leaveOneOutZ", () => {
  it("flags injected outlier member on max|z|", () => {
    const fits = Array.from({ length: 10 }, (_, i) =>
      makeFit(`member${i}`, i === 0 ? { 5: 3.0 } : { 5: 0.05 * i }),
    );
    const loo = leaveOneOutZ(fits, {
      minFiring: 30,
      minMembers: 8,
      fdr: 0.05,
      featureIds: FEATURE_IDS,
    });
    const outlier = loo.find((m) => m.userId === "member0");
    const others = loo.filter((m) => m.userId !== "member0");
    expect(outlier.maxAbsZ).toBeGreaterThan(2.5);
    for (const m of others) {
      expect(m.maxAbsZ).toBeLessThan(2);
    }
  });
});