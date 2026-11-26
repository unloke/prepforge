/** Sample-aware estimate of a historical opponent move at its exact position. */
export function opponentMoveProbability(moveGames, parentGames, method = "laplace") {
  if (parentGames <= 0 || moveGames < 0 || moveGames > parentGames) return 0;
  if (method === "raw") return moveGames / parentGames;
  if (method === "jeffreys") return (moveGames + 0.5) / (parentGames + 1);
  if (method === "wilson") {
    const z = 1.96;
    const p = moveGames / parentGames;
    const z2 = z * z;
    return (p + z2 / (2 * parentGames) - z * Math.sqrt(
      (p * (1 - p) + z2 / (4 * parentGames)) / parentGames,
    )) / (1 + z2 / parentGames);
  }
  return (moveGames + 1) / (parentGames + 2);
}

// Acklam's rational approximation of the standard normal quantile (|error| < 1.2e-9).
const QA = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
const QB = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
const QC = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const QD = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
const poly = (c, x) => c.reduce((acc, k) => acc * x + k, 0);

/** z such that P(Z <= z) = p for a standard normal Z (0 < p < 1). */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return p >= 1 ? Infinity : -Infinity;
  const tail = (q) => poly(QC, q) / (poly(QD, q) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (poly(QA, r) * q) / (poly(QB, r) * r + 1);
}

/**
 * Two-sided critical z for `tests` simultaneous tests at family-wise level `alpha`
 * (Bonferroni), never below the single-test `floor`. Testing many opening prefixes at
 * 1.96 each reports a "significant" branch in about half of all no-effect samples.
 */
export function bonferroniZ(tests, { alpha = 0.05, floor = 1.96 } = {}) {
  const m = Math.max(1, Math.floor(tests) || 1);
  return Math.max(floor, normalQuantile(1 - alpha / (2 * m)));
}
