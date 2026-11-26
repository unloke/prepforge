import { describe, expect, it } from "vitest";

import { openingBranches } from "./scout-stats.js";
import { bonferroniZ, normalQuantile } from "./scout-probability.js";

// Seeded LCG: the fixtures are identical on every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

// 400 White games over a skewed 8-ply opening tree. `scoreFor` decides each result,
// so the null fixture's results do not depend on the opening at all.
function corpus(seed, scoreFor) {
  const rnd = rng(seed);
  return Array.from({ length: 400 }, (_, i) => {
    const ucis = Array.from({ length: 8 }, (_, ply) => `p${ply}m${Math.floor(rnd() ** 3 * 5)}`);
    return { gameId: `g${i}`, color: "white", speed: "blitz", ucis, sans: ucis, score: scoreFor(ucis, rnd()) };
  });
}
const coinFlip = (_, r) => (r < 0.45 ? 1 : r < 0.55 ? 0.5 : 0);

describe("normal quantile and the multiple-testing threshold", () => {
  it("matches standard normal quantiles", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.5)).toBe(0);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
    expect(normalQuantile(1e-6)).toBeCloseTo(-4.753424, 5);
  });

  it("never drops below the single-test threshold and grows with the number of tests", () => {
    expect(bonferroniZ(1)).toBe(1.96);
    expect(bonferroniZ(0)).toBe(1.96);
    expect(bonferroniZ(50)).toBeCloseTo(3.2905, 3);
    expect(bonferroniZ(200)).toBeGreaterThan(bonferroniZ(50));
  });
});

describe("openingBranches under the multiple-testing correction", () => {
  it("reports no weak or strong branch when the opening has no effect on the result", () => {
    // Uncorrected, about half of these samples reported at least one "clear" branch.
    const flagged = Array.from({ length: 20 }, (_, i) => openingBranches(corpus(1000 + i, coinFlip), "white"))
      .filter((b) => b.weak.length || b.strong.length);
    expect(flagged.length).toBeLessThanOrEqual(1);
    expect(openingBranches(corpus(7, coinFlip), "white")).toMatchObject({ weak: [], strong: [] });
  });

  it("still finds a real gap", () => {
    // One first move in five; they score 25% there and ~55% everywhere else.
    const games = corpus(42, (ucis, r) => (ucis[0] === "p0m1" ? (r < 0.25 ? 1 : 0) : r < 0.55 ? 1 : 0));
    const share = games.filter((g) => g.ucis[0] === "p0m1").length / games.length;
    expect(share).toBeGreaterThan(0.1);
    const out = openingBranches(games, "white");
    expect(out.weak.some((b) => b.ucis[0] === "p0m1")).toBe(true);
    expect(out.strong).toEqual([]);
  });
});
