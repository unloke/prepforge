// Scout v12 §5 — cohort z-scores + Benjamini-Hochberg FDR (pure, zero deps).

const MIN_COHORT_MEMBERS = 8;

/** Standard normal CDF Φ(x) via Abramowitz & Stegun 26.2.17. */
export function normalCdf(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax));
  return 0.5 * (1 + sign * y);
}

/** Two-sided p-value from z under normal approximation. */
export function twoSidedPFromZ(z) {
  if (!Number.isFinite(z)) return NaN;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/** Sample standard deviation (n−1 denominator); returns NaN if n < 2. */
export function sampleSd(values) {
  const n = values.length;
  if (n < 2) return NaN;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let sumSq = 0;
  for (const v of values) {
    const d = v - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / (n - 1));
}

function nFeatures(fits) {
  if (!fits.length) return 0;
  const beta = fits[0].beta;
  return Array.isArray(beta) ? beta.length : 0;
}

function memberUsable(fit, fIdx, minFiring) {
  return (
    fit.converged === true &&
    Array.isArray(fit.beta) &&
    Array.isArray(fit.firingCounts) &&
    fit.firingCounts[fIdx] >= minFiring &&
    Number.isFinite(fit.beta[fIdx])
  );
}

/**
 * Per-feature cohort mean/sd from converged members with sufficient firing.
 * Features with < minMembers usable values are marked insufficient.
 */
export function cohortStats(fits, { minFiring = 30, minMembers = MIN_COHORT_MEMBERS } = {}) {
  const nF = nFeatures(fits);
  const means = new Array(nF).fill(NaN);
  const sds = new Array(nF).fill(NaN);
  const nUsable = new Array(nF).fill(0);
  const insufficient = new Array(nF).fill(true);

  for (let f = 0; f < nF; f += 1) {
    const vals = [];
    for (const fit of fits) {
      if (memberUsable(fit, f, minFiring)) vals.push(fit.beta[f]);
    }
    nUsable[f] = vals.length;
    if (vals.length < minMembers) {
      insufficient[f] = true;
      continue;
    }
    let mean = 0;
    for (const v of vals) mean += v;
    mean /= vals.length;
    means[f] = mean;
    sds[f] = sampleSd(vals);
    insufficient[f] = !(Number.isFinite(sds[f]) && sds[f] > 0);
  }

  return { means, sds, nUsable, insufficient, minFiring, minMembers };
}

/** Subject cohort z-scores and two-sided p-values per feature. */
export function subjectZ(subjectFit, stats) {
  const nF = stats.means.length;
  const z = new Array(nF).fill(NaN);
  const p = new Array(nF).fill(NaN);
  const beta = subjectFit.beta || [];

  for (let f = 0; f < nF; f += 1) {
    if (stats.insufficient[f]) continue;
    const sd = stats.sds[f];
    const mean = stats.means[f];
    const b = beta[f];
    if (!Number.isFinite(b) || !Number.isFinite(sd) || sd <= 0) continue;
    z[f] = (b - mean) / sd;
    p[f] = twoSidedPFromZ(z[f]);
  }

  return { z, p };
}

/**
 * Benjamini-Hochberg FDR: boolean mask (true = survives) aligned to pvals input order.
 * Non-finite p-values are treated as not surviving.
 */
export function benjaminiHochberg(pvals, alpha = 0.05) {
  const m = pvals.length;
  const mask = new Array(m).fill(false);
  const indexed = [];
  for (let i = 0; i < m; i += 1) {
    const pv = pvals[i];
    if (Number.isFinite(pv)) indexed.push({ i, p: pv });
  }
  if (!indexed.length) return mask;

  indexed.sort((a, b) => a.p - b.p);
  let maxK = -1;
  for (let k = 0; k < indexed.length; k += 1) {
    const rank = k + 1;
    if (indexed[k].p <= (rank / indexed.length) * alpha) maxK = k;
  }
  if (maxK < 0) return mask;
  for (let k = 0; k <= maxK; k += 1) mask[indexed[k].i] = true;
  return mask;
}

/**
 * Leave-one-out cohort z for each member (§7.2 discrimination null).
 * Returns per-member max|z|, BH survivor count, and full z vectors.
 */
export function leaveOneOutZ(
  fits,
  {
    minFiring = 30,
    minMembers = MIN_COHORT_MEMBERS,
    fdr = 0.05,
    featureIds = null,
  } = {},
) {
  const nF = nFeatures(fits);
  const ids = featureIds || [...Array(nF).keys()].map(String);
  const members = [];

  for (let i = 0; i < fits.length; i += 1) {
    const held = fits[i];
    const rest = fits.filter((_, j) => j !== i);
    const stats = cohortStats(rest, { minFiring, minMembers });
    const { z, p } = subjectZ(held, stats);
    const testable = [];
    for (let f = 0; f < nF; f += 1) {
      if (!stats.insufficient[f] && Number.isFinite(p[f])) testable.push(f);
    }
    const pTest = testable.map((f) => p[f]);
    const bhLocal = benjaminiHochberg(pTest, fdr);
    let bhSurvivors = 0;
    for (let t = 0; t < testable.length; t += 1) {
      if (bhLocal[t]) bhSurvivors += 1;
    }
    let maxAbsZ = 0;
    for (let f = 0; f < nF; f += 1) {
      if (Number.isFinite(z[f])) maxAbsZ = Math.max(maxAbsZ, Math.abs(z[f]));
    }
    members.push({
      userId: held.userId,
      z,
      p,
      maxAbsZ,
      bhSurvivors,
      stats,
      featureIds: ids,
    });
  }

  return members;
}

/** Summarize leave-one-out max|z| and BH survivor counts for console/report. */
export function summarizeLeaveOneOut(looMembers) {
  const maxAbsZs = looMembers.map((m) => m.maxAbsZ);
  const bhCounts = looMembers.map((m) => m.bhSurvivors);
  const sortedZ = [...maxAbsZs].sort((a, b) => a - b);
  const sortedBh = [...bhCounts].sort((a, b) => a - b);
  const pct = (arr, q) => {
    if (!arr.length) return NaN;
    const idx = Math.min(arr.length - 1, Math.floor(q * (arr.length - 1)));
    return arr[idx];
  };
  return {
    maxAbsZ: {
      min: sortedZ[0] ?? NaN,
      median: pct(sortedZ, 0.5),
      max: sortedZ[sortedZ.length - 1] ?? NaN,
      all: maxAbsZs,
    },
    bhSurvivors: {
      min: sortedBh[0] ?? NaN,
      median: pct(sortedBh, 0.5),
      max: sortedBh[sortedBh.length - 1] ?? NaN,
      all: bhCounts,
    },
  };
}