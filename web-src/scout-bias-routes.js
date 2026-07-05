// Scout v12 — route derivation: tilted-policy leak attribution, reach, soundness, selection.
// Pure functions only — no Node builtins, no engine I/O.

export const P_FLOOR = 1e-6;
export const JEFFREYS_Z = 1.2816;
export const DELTA_MAX_CP = 500;
export const SOUNDNESS_MIN_CP = -30;
export const SOUNDNESS_PATH_TOLERANCE_CP = 30;
export const ENTRY_PLY_LIMIT = 6;
export const MAX_ROUTES_PER_TENDENCY = 3;

// --- Jeffreys lower bound (Beta(k+0.5, n-k+0.5) one-sided, z=1.2816 ≈ 10%) ---------------

function logGamma(z) {
  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.98434977e-6, 1.50563277e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = coef[0];
  for (let i = 1; i < g + 2; i += 1) x += coef[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Continued fraction for regularized incomplete beta (jStat / Numerical Recipes). */
function betacf(x, a, b) {
  const fpmin = 1e-30;
  const eps = 3e-7;
  const maxIter = 200;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
function betaCdf(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

/** Inverse CDF of Beta(a,b) by bisection. */
export function betaInv(p, a, b) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const cdf = betaCdf(mid, a, b);
    if (cdf < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const poly =
    t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  const p = 1 - d * poly;
  return z < 0 ? 1 - p : p;
}

/**
 * Jeffreys one-sided lower bound on k/n (design §2.2 anchor: k=1,n=1→~0.09; k=5,n=5→~0.68).
 * @param {number} k successes (games on chosen child edge)
 * @param {number} n trials (games reaching parent)
 */
export function jeffreysLower(k, n, z = JEFFREYS_Z) {
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(k) || k <= 0) return 0;
  const kk = Math.min(k, n);
  const a = kk + 0.5;
  const b = n - kk + 0.5;
  // One-sided 10% lower (design α_LB=0.10 ↔ z=1.2816).
  const alpha = normalCdf(-z);
  return Math.max(0, Math.min(1, betaInv(alpha, a, b)));
}

// --- Tilted policy --------------------------------------------------------------------------

function softmaxLogits(logits) {
  const k = logits.length;
  let maxLogit = -Infinity;
  for (let i = 0; i < k; i += 1) if (logits[i] > maxLogit) maxLogit = logits[i];
  let sum = 0;
  const probs = new Float64Array(k);
  for (let i = 0; i < k; i += 1) {
    const e = Math.exp(logits[i] - maxLogit);
    probs[i] = e;
    sum += e;
  }
  const inv = sum > 0 ? 1 / sum : 1 / k;
  return probs.map((p) => p * inv);
}

/**
 * π_tilt(m) ∝ π_maia(m)·exp(Σ_f β_f·x_f(m)).
 * @param {boolean[]|null} activeMask — when set, only indices with true contribute.
 */
export function tiltedProbs(cands, beta, activeMask = null) {
  const nFeatures = beta.length;
  const logits = cands.map((c) => {
    const p = Math.max(c.p, P_FLOOR);
    let dot = Math.log(p);
    const fi = c.f;
    for (let f = 0; f < nFeatures; f += 1) {
      if (activeMask && !activeMask[f]) continue;
      dot += beta[f] * fi[f];
    }
    return dot;
  });
  return softmaxLogits(logits);
}

/** π_raw — renormalized Maia priors. */
export function rawProbs(cands) {
  let sum = 0;
  const raw = cands.map((c) => {
    const p = Math.max(c.p, P_FLOOR);
    sum += p;
    return p;
  });
  const inv = sum > 0 ? 1 / sum : 1 / cands.length;
  return raw.map((p) => p * inv);
}

// --- Eval leak (Δ, ELoss) -------------------------------------------------------------------

/** Δ(m) = max(0, cpAfterBest − cpAfter(m)), clamped to [0, DELTA_MAX_CP]. */
export function moveDeltaCp(cpAfter, cpBest) {
  const delta = Math.max(0, (Number(cpBest) || 0) - (Number(cpAfter) || 0));
  return clampDeltaCp(delta);
}

export function clampDeltaCp(delta) {
  const n = Number(delta);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(DELTA_MAX_CP, n);
}

/** ELoss(π) = Σ_m π(m)·Δ(m). */
export function expectedLoss(probs, deltas) {
  let loss = 0;
  for (let i = 0; i < probs.length; i += 1) {
    loss += (probs[i] || 0) * (deltas[i] || 0);
  }
  return loss;
}

/**
 * Per-feature attribution: ELoss(π_tilt) − ELoss(π_tilt with β_f zeroed).
 * Positive ⇒ this bias leaks eval at the node.
 */
export function attributionForFeature(cands, beta, featureIdx, deltas, activeMask = null) {
  const mask = activeMask ? [...activeMask] : beta.map(() => true);
  const piTilt = tiltedProbs(cands, beta, mask);
  const elossFull = expectedLoss(piTilt, deltas);
  const maskZero = [...mask];
  maskZero[featureIdx] = false;
  const piZero = tiltedProbs(cands, beta, maskZero);
  const elossZero = expectedLoss(piZero, deltas);
  return elossFull - elossZero;
}

/** Highest π_tilt·Δ leak move for receipts. */
export function topLeakMove(cands, piTilt, piRaw, deltas) {
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < cands.length; i += 1) {
    const score = (piTilt[i] || 0) * (deltas[i] || 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return null;
  return {
    san: cands[best].san ?? cands[best].uci,
    uci: cands[best].uci,
    piTilt: piTilt[best],
    piRaw: piRaw[best],
    deltaCp: deltas[best],
  };
}

// --- Reach along trie path ------------------------------------------------------------------

/**
 * Product of Jeffreys LB at HIS decision edges; OUR plies contribute factor 1.
 * @param {Array<{ isHisMove: boolean, childGames: number, parentGames: number }>} segments
 */
export function pathReachLB(segments) {
  if (!segments?.length) return 1;
  let product = 1;
  for (const seg of segments) {
    if (!seg.isHisMove) continue;
    product *= jeffreysLower(seg.childGames, seg.parentGames);
  }
  return product;
}

// --- Stockfish perspective (OUR side) -------------------------------------------------------

/**
 * Convert engine score to centipawns from OUR color's perspective.
 * SF reports for side-to-move; mate maps to ±1000 cp.
 */
export function sfScoreToOurCp(score, sideToMove, ourColor) {
  if (!score || typeof score !== "object") return 0;
  let cp;
  if (score.type === "mate") {
    const mate = Number(score.value);
    cp = mate > 0 ? 1000 : -1000;
  } else {
    cp = Number(score.cp) || 0;
  }
  if (sideToMove !== ourColor) cp = -cp;
  return cp;
}

/** Parse a final-depth `info` line (mocked in tests). */
export function parseSfInfoScore(infoLine, ourColor, sideToMove) {
  const mate = infoLine.match(/\bscore\s+mate\s+(-?\d+)/);
  if (mate) {
    return sfScoreToOurCp({ type: "mate", value: Number(mate[1]) }, sideToMove, ourColor);
  }
  const cp = infoLine.match(/\bscore\s+cp\s+(-?\d+)/);
  if (cp) {
    return sfScoreToOurCp({ type: "cp", cp: Number(cp[1]) }, sideToMove, ourColor);
  }
  return 0;
}

// --- Soundness gate -------------------------------------------------------------------------

/**
 * Node eval for our side ≥ minCp, and every OUR-move eval on the path within tolerance of best.
 * @param {number} nodeEvalCp — SF eval at the route node (our POV)
 * @param {Array<{ evalCp: number, bestCp: number }>} ourPathChecks — one per OUR ply on path
 */
export function isRouteSound(nodeEvalCp, ourPathChecks, {
  minCp = SOUNDNESS_MIN_CP,
  pathTolerance = SOUNDNESS_PATH_TOLERANCE_CP,
} = {}) {
  if (!Number.isFinite(nodeEvalCp) || nodeEvalCp < minCp) return false;
  for (const chk of ourPathChecks || []) {
    const gap = (chk.bestCp ?? 0) - (chk.evalCp ?? 0);
    if (gap > pathTolerance) return false;
  }
  return true;
}

// --- Route entry + selection ----------------------------------------------------------------

/**
 * Entry = OUR move choices within the first `maxPlies` game plies (≈ ceil(maxPlies/2)
 * of our moves). Two routes are the same entry only if ALL those choices coincide —
 * a forced shared first reply (e.g. vs a 100% 1.e4 player) must not collapse every
 * route into one entry.
 */
export function ourEntryKey(ourMoves, maxPlies = ENTRY_PLY_LIMIT) {
  if (!ourMoves?.length) return "";
  return ourMoves.slice(0, Math.ceil(maxPlies / 2)).join(" ");
}

/**
 * Greedily pick up to maxRoutes with distinct entries; same-entry duplicates keep best rank only.
 * Input must be pre-sorted best-first by rankScore.
 */
export function selectDistinctRoutes(candidates, {
  maxRoutes = MAX_ROUTES_PER_TENDENCY,
  entryPlyLimit = ENTRY_PLY_LIMIT,
} = {}) {
  const picked = [];
  const seenEntry = new Map();
  const seenEpd = new Set();
  for (const cand of candidates) {
    if (cand.sound === false) continue;
    // Move-order transpositions reach the same position — one route, not two.
    if (cand.epd && seenEpd.has(cand.epd)) continue;
    const key = ourEntryKey(cand.ourMoves, entryPlyLimit);
    if (seenEntry.has(key)) continue;
    seenEntry.set(key, true);
    if (cand.epd) seenEpd.add(cand.epd);
    picked.push(cand);
    if (picked.length >= maxRoutes) break;
  }
  return picked;
}

export function rankScore(reachLB, attribution) {
  return (Number(reachLB) || 0) * Math.max(0, Number(attribution) || 0);
}

/** Collapse same-entry duplicates in a ranked list (keep best rankScore). */
export function collapseSameEntry(candidates, entryPlyLimit = ENTRY_PLY_LIMIT) {
  const best = new Map();
  for (const cand of candidates) {
    const key = ourEntryKey(cand.ourMoves, entryPlyLimit);
    const prev = best.get(key);
    if (!prev || (cand.rankScore ?? 0) > (prev.rankScore ?? 0)) best.set(key, cand);
  }
  return [...best.values()].sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
}

// --- Stable tendencies from fit report ------------------------------------------------------

/**
 * Pick time-split-stable features from a fit report.
 * Falls back to |z|≥2 featuresByAbsZ when reliability.features is absent.
 */
export function pickStableTendencies(fitReport, featureIds) {
  const relFeatures = fitReport?.reliability?.features;
  if (Array.isArray(relFeatures) && relFeatures.length) {
    return relFeatures
      .filter((f) => f.stable)
      .map((f) => ({
        featureId: f.id,
        featureIdx: featureIds.indexOf(f.id),
        beta: f.betaFull,
        zFull: f.zFull,
        stable: true,
        source: "reliability",
      }))
      .filter((f) => f.featureIdx >= 0);
  }

  const betaMap = fitReport?.fit?.beta || {};
  const rows = fitReport?.fit?.featuresByAbsZ || [];
  return rows
    .filter((r) => Math.abs(r.z ?? 0) >= 2)
    .map((r) => ({
      featureId: r.id,
      featureIdx: featureIds.indexOf(r.id),
      beta: r.beta ?? betaMap[r.id],
      zFull: r.z,
      stable: false,
      source: "featuresByAbsZ_fallback",
    }))
    .filter((f) => f.featureIdx >= 0);
}

/** Build active mask from stable tendency indices. */
export function stableFeatureMask(featureIds, tendencies) {
  const mask = featureIds.map(() => false);
  for (const t of tendencies) {
    if (t.featureIdx >= 0 && t.featureIdx < mask.length) mask[t.featureIdx] = true;
  }
  return mask;
}

/** Verdict label for a tendency's route set. */
export function tendencyVerdict(routes) {
  return routes?.length >= 1 ? "prep" : "analysis-only";
}