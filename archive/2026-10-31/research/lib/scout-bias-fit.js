// Scout v12 — conditional logit tilt on Maia: P_i ∝ p_maia_i · exp(β·f_i).
// Pure math, zero dependencies.

const P_FLOOR = 1e-6;

/** Cholesky L for symmetric positive-definite A (A = L Lᵀ). Returns null if not SPD. */
function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k += 1) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (sum <= 0) return null;
        L[i * n + j] = Math.sqrt(sum);
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }
  return L;
}

/** Solve A x = b for SPD A via Cholesky (A = L Lᵀ). */
export function solveSpd(A, b, n) {
  const L = cholesky(A, n);
  if (!L) return null;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = b[i];
    for (let k = 0; k < i; k += 1) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = y[i];
    for (let k = i + 1; k < n; k += 1) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}

/** Invert SPD matrix (for SE diagonal). */
function invertSpd(A, n) {
  const inv = new Float64Array(n * n);
  const col = new Float64Array(n);
  const b = new Float64Array(n);
  for (let j = 0; j < n; j += 1) {
    b.fill(0);
    b[j] = 1;
    const x = solveSpd(A, b, n);
    if (!x) return null;
    for (let i = 0; i < n; i += 1) inv[i * n + j] = x[i];
  }
  return inv;
}

function featureVaries(cands, fIdx) {
  const k = cands.length;
  if (k < 2) return false;
  const v0 = cands[0].f[fIdx];
  for (let i = 1; i < k; i += 1) {
    if (cands[i].f[fIdx] !== v0) return true;
  }
  return false;
}

function computeFiringCounts(decisions, nFeatures) {
  const counts = new Array(nFeatures).fill(0);
  for (const dec of decisions) {
    for (let f = 0; f < nFeatures; f += 1) {
      if (featureVaries(dec.cands, f)) counts[f] += 1;
    }
  }
  return counts;
}

/** Log-prob of played move and model moments for one decision. */
function decisionMoments(cands, playedIdx, beta, nFeatures) {
  const k = cands.length;
  const logits = new Float64Array(k);
  let maxLogit = -Infinity;
  for (let i = 0; i < k; i += 1) {
    const p = Math.max(cands[i].p, P_FLOOR);
    let dot = Math.log(p);
    const fi = cands[i].f;
    for (let f = 0; f < nFeatures; f += 1) dot += beta[f] * fi[f];
    logits[i] = dot;
    if (dot > maxLogit) maxLogit = dot;
  }
  let sumExp = 0;
  const probs = new Float64Array(k);
  for (let i = 0; i < k; i += 1) {
    const e = Math.exp(logits[i] - maxLogit);
    probs[i] = e;
    sumExp += e;
  }
  const invSum = 1 / sumExp;
  const logProbPlayed = logits[playedIdx] - maxLogit - Math.log(sumExp);

  const meanF = new Float64Array(nFeatures);
  for (let i = 0; i < k; i += 1) {
    const pi = probs[i] * invSum;
    const fi = cands[i].f;
    for (let f = 0; f < nFeatures; f += 1) meanF[f] += pi * fi[f];
  }

  const cov = new Float64Array(nFeatures * nFeatures);
  for (let i = 0; i < k; i += 1) {
    const pi = probs[i] * invSum;
    const fi = cands[i].f;
    for (let a = 0; a < nFeatures; a += 1) {
      const da = fi[a] - meanF[a];
      for (let b = a; b < nFeatures; b += 1) {
        cov[a * nFeatures + b] += pi * da * (fi[b] - meanF[b]);
      }
    }
  }
  for (let a = 0; a < nFeatures; a += 1) {
    for (let b = 0; b < a; b += 1) cov[a * nFeatures + b] = cov[b * nFeatures + a];
  }

  return { logProbPlayed, meanF, cov, probs, invSum, logits, maxLogit };
}

function evalLogLik(decisions, beta, nFeatures, l2) {
  let ll = 0;
  for (const dec of decisions) {
    const playedIdx = dec.playedIdx ?? 0;
    const { logProbPlayed } = decisionMoments(dec.cands, playedIdx, beta, nFeatures);
    ll += logProbPlayed;
  }
  for (let f = 0; f < nFeatures; f += 1) ll -= l2 * beta[f] * beta[f];
  return ll;
}

function logLikAndDerivs(decisions, beta, nFeatures, l2) {
  let ll = 0;
  const grad = new Float64Array(nFeatures);
  const hess = new Float64Array(nFeatures * nFeatures);
  for (const dec of decisions) {
    const playedIdx = dec.playedIdx ?? 0;
    const { logProbPlayed, meanF, cov } = decisionMoments(dec.cands, playedIdx, beta, nFeatures);
    ll += logProbPlayed;
    const fp = dec.cands[playedIdx].f;
    for (let f = 0; f < nFeatures; f += 1) grad[f] += fp[f] - meanF[f];
    for (let a = 0; a < nFeatures; a += 1) {
      for (let b = 0; b < nFeatures; b += 1) hess[a * nFeatures + b] -= cov[a * nFeatures + b];
    }
  }
  for (let f = 0; f < nFeatures; f += 1) {
    ll -= l2 * beta[f] * beta[f];
    grad[f] -= 2 * l2 * beta[f];
    hess[f * nFeatures + f] -= 2 * l2;
  }
  return { ll, grad, hess };
}

function logLikRaw(decisions) {
  let ll = 0;
  for (const dec of decisions) {
    const playedIdx = dec.playedIdx ?? 0;
    const k = dec.cands.length;
    let sumP = 0;
    for (let i = 0; i < k; i += 1) sumP += Math.max(dec.cands[i].p, P_FLOOR);
    const pPlayed = Math.max(dec.cands[playedIdx].p, P_FLOOR);
    ll += Math.log(pPlayed / sumP);
  }
  return ll;
}

/**
 * Fit L2-penalized conditional logit on Maia tilt.
 * @param {Array<{ cands: Array<{ p: number, f: number[] }>, playedIdx?: number }>} decisions
 * @param {{ l2?: number, maxIter?: number, tol?: number }} opts
 */
export function fitBias(decisions, { l2 = 1e-3, maxIter = 300, tol = 1e-7 } = {}) {
  if (!decisions.length) {
    return {
      beta: [],
      se: [],
      z: [],
      logLik: 0,
      logLikRaw: 0,
      iterations: 0,
      converged: true,
      firingCounts: [],
    };
  }
  const nFeatures = decisions[0].cands[0].f.length;
  const beta = new Float64Array(nFeatures);
  const logLikRawVal = logLikRaw(decisions);
  let ll = evalLogLik(decisions, beta, nFeatures, l2);
  let converged = false;
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter += 1) {
    iterations = iter + 1;
    const llBefore = ll;
    const { grad, hess } = logLikAndDerivs(decisions, beta, nFeatures, l2);

    const negHess = new Float64Array(nFeatures * nFeatures);
    for (let a = 0; a < nFeatures * nFeatures; a += 1) negHess[a] = -hess[a];

    // Newton for maximization: (-H) δ = ∇J  ⇒  δ = -H⁻¹∇J
    const step = solveSpd(negHess, grad, nFeatures);
    if (!step) break;

    let alpha = 1;
    const betaTrial = new Float64Array(nFeatures);
    let llAfter = llBefore;
    for (let halve = 0; halve < 20; halve += 1) {
      for (let f = 0; f < nFeatures; f += 1) betaTrial[f] = beta[f] + alpha * step[f];
      const trialLl = evalLogLik(decisions, betaTrial, nFeatures, l2);
      if (trialLl >= llBefore - 1e-12) {
        llAfter = trialLl;
        break;
      }
      alpha *= 0.5;
    }
    for (let f = 0; f < nFeatures; f += 1) beta[f] = beta[f] + alpha * step[f];
    ll = llAfter;

    let gNorm = 0;
    for (let f = 0; f < nFeatures; f += 1) gNorm += grad[f] * grad[f];
    if (Math.sqrt(gNorm) < tol || Math.abs(llAfter - llBefore) < tol) {
      converged = true;
      break;
    }
  }

  if (!converged) {
    const { grad: gradFinal } = logLikAndDerivs(decisions, beta, nFeatures, l2);
    let gNorm = 0;
    for (let f = 0; f < nFeatures; f += 1) gNorm += gradFinal[f] * gradFinal[f];
    if (Math.sqrt(gNorm) < tol * 10) converged = true;
  }

  const { hess: hessFinal } = logLikAndDerivs(decisions, beta, nFeatures, l2);
  const negHessFinal = new Float64Array(nFeatures * nFeatures);
  for (let a = 0; a < nFeatures * nFeatures; a += 1) negHessFinal[a] = -hessFinal[a];
  const inv = invertSpd(negHessFinal, nFeatures);

  const se = new Array(nFeatures);
  const z = new Array(nFeatures);
  const betaOut = new Array(nFeatures);
  for (let f = 0; f < nFeatures; f += 1) {
    betaOut[f] = beta[f];
    const v = inv ? inv[f * nFeatures + f] : NaN;
    se[f] = v > 0 ? Math.sqrt(v) : NaN;
    z[f] = se[f] > 0 && Number.isFinite(se[f]) ? beta[f] / se[f] : NaN;
  }

  return {
    beta: betaOut,
    se,
    z,
    logLik: ll,
    logLikRaw: logLikRawVal,
    iterations,
    converged,
    firingCounts: computeFiringCounts(decisions, nFeatures),
  };
}

/** Summed log-probability of played moves under fitted β vs raw Maia (β=0). */
export function heldOutLogLik(decisions, beta) {
  const nFeatures = beta.length;
  let model = 0;
  let raw = 0;
  for (const dec of decisions) {
    const playedIdx = dec.playedIdx ?? 0;
    const { logProbPlayed } = decisionMoments(dec.cands, playedIdx, beta, nFeatures);
    model += logProbPlayed;
    const k = dec.cands.length;
    let sumP = 0;
    for (let i = 0; i < k; i += 1) sumP += Math.max(dec.cands[i].p, P_FLOOR);
    const pPlayed = Math.max(dec.cands[playedIdx].p, P_FLOOR);
    raw += Math.log(pPlayed / sumP);
  }
  return { model, raw, n: decisions.length };
}

/** Top-1 accuracy: played move has highest model probability. */
export function top1Accuracy(decisions, beta) {
  const nFeatures = beta.length;
  let correct = 0;
  for (const dec of decisions) {
    const playedIdx = dec.playedIdx ?? 0;
    const { probs, invSum } = decisionMoments(dec.cands, playedIdx, beta, nFeatures);
    let best = -1;
    let bestP = -1;
    for (let i = 0; i < dec.cands.length; i += 1) {
      const pi = probs[i] * invSum;
      if (pi > bestP) {
        bestP = pi;
        best = i;
      }
    }
    if (best === playedIdx) correct += 1;
  }
  return { correct, n: decisions.length, rate: decisions.length ? correct / decisions.length : 0 };
}

/** Pearson correlation of two equal-length vectors (ignores NaN pairs). */
export function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  let count = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sumA += x;
    sumB += y;
    sumAA += x * x;
    sumBB += y * y;
    sumAB += x * y;
    count += 1;
  }
  if (count < 2) return NaN;
  const meanA = sumA / count;
  const meanB = sumB / count;
  const cov = sumAB / count - meanA * meanB;
  const varA = sumAA / count - meanA * meanA;
  const varB = sumBB / count - meanB * meanB;
  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : NaN;
}

/** Parse NDJSON bias dump → { header, decisions }. */
export function loadDump(text) {
  const lines = text.split(/\r?\n/).filter((ln) => ln.trim());
  if (!lines.length) throw new Error("empty dump");
  const header = JSON.parse(lines[0]);
  const decisions = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = JSON.parse(lines[i]);
    const cands = row.cands.map((c) => ({
      uci: c.uci,
      p: c.p,
      f: c.f,
    }));
    decisions.push({
      g: row.g,
      ply: row.ply,
      color: row.color,
      epd: row.epd,
      played: row.played,
      cands,
      playedIdx: 0,
      meta: row.meta,
    });
  }
  return { header, decisions };
}

/** Normalize decisions to fitBias input (playedIdx explicit). */
export function decisionsForFit(decisions) {
  return decisions.map((d) => ({
    cands: d.cands.map((c) => ({ p: c.p, f: c.f })),
    playedIdx: d.playedIdx ?? 0,
  }));
}

/** Sample played move from tilted model (for synthetic data). */
export function samplePlayedFromModel(cands, beta, rng) {
  const nFeatures = beta.length;
  const k = cands.length;
  const logits = new Float64Array(k);
  let maxLogit = -Infinity;
  for (let i = 0; i < k; i += 1) {
    const p = Math.max(cands[i].p, P_FLOOR);
    let dot = Math.log(p);
    const fi = cands[i].f;
    for (let f = 0; f < nFeatures; f += 1) dot += beta[f] * fi[f];
    logits[i] = dot;
    if (dot > maxLogit) maxLogit = dot;
  }
  let sumExp = 0;
  const probs = new Float64Array(k);
  for (let i = 0; i < k; i += 1) {
    probs[i] = Math.exp(logits[i] - maxLogit);
    sumExp += probs[i];
  }
  const u = rng() * sumExp;
  let acc = 0;
  for (let i = 0; i < k; i += 1) {
    acc += probs[i];
    if (u <= acc) return i;
  }
  return k - 1;
}

/** Sign of β; |β| < 1e-9 → 0 (never agrees with another sign). */
export function betaSign(beta) {
  if (!Number.isFinite(beta) || Math.abs(beta) < 1e-9) return 0;
  return beta > 0 ? 1 : -1;
}

/** Split decisions into early/late game sets by per-game minimum datestamp median. */
export function splitGamesByDatestamp(decisions) {
  const gameDates = new Map();
  for (const d of decisions) {
    const ds = d.meta?.datestamp;
    if (ds == null) continue;
    const prev = gameDates.get(d.g);
    if (prev == null || ds < prev) gameDates.set(d.g, ds);
  }
  const dates = [...gameDates.values()].sort((a, b) => a - b);
  const median = dates[Math.floor(dates.length / 2)] ?? 0;
  const earlyGames = new Set();
  const lateGames = new Set();
  for (const [g, ds] of gameDates) {
    if (ds <= median) earlyGames.add(g);
    else lateGames.add(g);
  }
  const early = decisions.filter((d) => earlyGames.has(d.g));
  const late = decisions.filter((d) => lateGames.has(d.g));
  return { early, late, median, earlyGames: earlyGames.size, lateGames: lateGames.size };
}

/**
 * Per-feature time-split stability rows for features that fired in both halves.
 * @param {{ minFiring?: number, minFiringForCorr?: number }} opts
 */
export function buildReliabilityFeatures(fitEarly, fitLate, fitFull, featureIds, {
  minFiring = 1,
  minFiringForCorr = 30,
} = {}) {
  const features = [];
  const used = [];
  const dropped = [];
  for (let i = 0; i < featureIds.length; i += 1) {
    const firingEarly = fitEarly.firingCounts[i] ?? 0;
    const firingLate = fitLate.firingCounts[i] ?? 0;
    if (firingEarly >= minFiringForCorr && firingLate >= minFiringForCorr) {
      used.push(i);
    } else {
      dropped.push({
        id: featureIds[i],
        firingEarly,
        firingLate,
      });
    }
    if (firingEarly < minFiring || firingLate < minFiring) continue;

    const betaEarly = fitEarly.beta[i];
    const seEarly = fitEarly.se[i];
    const zEarly = fitEarly.z[i];
    const betaLate = fitLate.beta[i];
    const seLate = fitLate.se[i];
    const zLate = fitLate.z[i];
    const betaFull = fitFull.beta[i];
    const zFull = fitFull.z[i];
    const firingFull = fitFull.firingCounts[i] ?? 0;
    const signAgree = betaSign(betaEarly) === betaSign(betaLate) && betaSign(betaEarly) !== 0;
    const stable = signAgree
      && Math.min(firingEarly, firingLate) >= 30
      && Math.abs(zFull) >= 2
      && Math.min(Math.abs(zEarly), Math.abs(zLate)) >= 1;

    features.push({
      id: featureIds[i],
      betaEarly,
      seEarly,
      zEarly,
      firingEarly,
      betaLate,
      seLate,
      zLate,
      firingLate,
      betaFull,
      zFull,
      firingFull,
      signAgree,
      stable,
    });
  }
  features.sort((a, b) => Math.abs(b.zFull ?? 0) - Math.abs(a.zFull ?? 0));
  return { features, used, dropped };
}

/**
 * §7.1 reliability: early/late β fits, Pearson r, and per-feature stability.
 * @param {object} fitFull — full-data fit (caller already computed).
 */
export function reliabilitySplit(decisions, opts, { fitFull, featureIds }) {
  const { early, late, median, earlyGames, lateGames } = splitGamesByDatestamp(decisions);
  const fitEarly = fitBias(decisionsForFit(early), opts);
  const fitLate = fitBias(decisionsForFit(late), opts);
  const { features, used, dropped } = buildReliabilityFeatures(
    fitEarly,
    fitLate,
    fitFull,
    featureIds,
  );
  const betaEarly = used.map((i) => fitEarly.beta[i]);
  const betaLate = used.map((i) => fitLate.beta[i]);
  const r = pearsonCorr(betaEarly, betaLate);
  return {
    r,
    usedFeatures: used.map((i) => featureIds[i]),
    dropped,
    features,
    fitEarly,
    fitLate,
    earlyDecisions: early.length,
    lateDecisions: late.length,
    earlyGames,
    lateGames,
    medianDatestamp: median,
  };
}

/** Sample played move proportional to raw Maia p (renormalized). */
export function samplePlayedFromMaia(cands, rng) {
  const k = cands.length;
  let sumP = 0;
  for (let i = 0; i < k; i += 1) sumP += Math.max(cands[i].p, P_FLOOR);
  const u = rng() * sumP;
  let acc = 0;
  for (let i = 0; i < k; i += 1) {
    acc += Math.max(cands[i].p, P_FLOOR);
    if (u <= acc) return i;
  }
  return k - 1;
}