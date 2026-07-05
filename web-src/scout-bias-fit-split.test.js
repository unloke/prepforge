import { describe, expect, it } from "vitest";

import {
  buildReliabilityFeatures,
  decisionsForFit,
  fitBias,
  reliabilitySplit,
  samplePlayedFromModel,
} from "./scout-bias-fit.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSparseFeatures(nFeatures, rng, density = 0.25) {
  const f = new Array(nFeatures).fill(0);
  for (let i = 0; i < nFeatures; i += 1) {
    if (rng() < density) f[i] = 1;
  }
  return f;
}

function makeSyntheticDecision(nFeatures, nCands, beta, rng, { activeFeatures = null } = {}) {
  const cands = [];
  for (let i = 0; i < nCands; i += 1) {
    const p = 0.001 + rng() * 0.5;
    cands.push({ p, f: randomSparseFeatures(nFeatures, rng) });
  }
  for (let fi = 0; fi < nFeatures; fi += 1) {
    if (activeFeatures && !activeFeatures[fi]) continue;
    if (beta[fi] === 0) continue;
    if (!cands.some((c) => c.f[fi] === 0)) cands[Math.floor(rng() * nCands)].f[fi] = 0;
    if (!cands.some((c) => c.f[fi] === 1)) cands[Math.floor(rng() * nCands)].f[fi] = 1;
  }
  const playedIdx = samplePlayedFromModel(cands, beta, rng);
  const picked = cands[playedIdx];
  cands.splice(playedIdx, 1);
  cands.unshift(picked);
  return { cands, playedIdx: 0 };
}

function makeSplitCohort({
  nFeatures,
  nCands,
  earlyGames = 26,
  lateGames = 24,
  decisionsPerGame,
  earlyBeta,
  lateBeta,
  seed,
  activeFeatures = null,
}) {
  const rng = mulberry32(seed);
  const decisions = [];
  const featureIds = Array.from({ length: nFeatures }, (_, i) => `f${i}`);
  for (let g = 0; g < earlyGames; g += 1) {
    const gameId = `early-${g}`;
    const datestamp = 100;
    for (let d = 0; d < decisionsPerGame; d += 1) {
      const dec = makeSyntheticDecision(nFeatures, nCands, earlyBeta, rng, { activeFeatures });
      decisions.push({ ...dec, g: gameId, meta: { datestamp } });
    }
  }
  for (let g = 0; g < lateGames; g += 1) {
    const gameId = `late-${g}`;
    const datestamp = 200;
    for (let d = 0; d < decisionsPerGame; d += 1) {
      const dec = makeSyntheticDecision(nFeatures, nCands, lateBeta, rng, { activeFeatures });
      decisions.push({ ...dec, g: gameId, meta: { datestamp } });
    }
  }
  return { decisions, featureIds };
}

describe("buildReliabilityFeatures", () => {
  it("marks low firing in one half as unstable", () => {
    const featureIds = ["persistent", "sparse"];
    const fitEarly = {
      beta: [0.6, 0.4],
      se: [0.1, 0.1],
      z: [6, 4],
      firingCounts: [80, 50],
    };
    const fitLate = {
      beta: [0.55, 0.35],
      se: [0.1, 0.1],
      z: [5.5, 3.5],
      firingCounts: [75, 12],
    };
    const fitFull = {
      beta: [0.58, 0.38],
      se: [0.08, 0.08],
      z: [7.25, 4.75],
      firingCounts: [155, 62],
    };
    const { features } = buildReliabilityFeatures(fitEarly, fitLate, fitFull, featureIds);
    const sparse = features.find((f) => f.id === "sparse");
    expect(sparse).toBeDefined();
    expect(sparse.stable).toBe(false);
    expect(sparse.signAgree).toBe(true);
  });
});

describe("reliabilitySplit synthetic", () => {
  it("marks a persistent β feature as stable", () => {
    const nFeatures = 5;
    const trueBeta = [1.0, 0, 0, 0, 0];
    const { decisions, featureIds } = makeSplitCohort({
      nFeatures,
      nCands: 8,
      decisionsPerGame: 80,
      earlyBeta: trueBeta,
      lateBeta: trueBeta,
      seed: 42,
    });
    const opts = { l2: 1e-3, maxIter: 300, tol: 1e-7 };
    const fitFull = fitBias(decisionsForFit(decisions), opts);
    const rel = reliabilitySplit(decisions, opts, { fitFull, featureIds });
    const f0 = rel.features.find((f) => f.id === "f0");
    expect(f0).toBeDefined();
    expect(f0.signAgree).toBe(true);
    expect(f0.stable).toBe(true);
    expect(Math.abs(f0.zFull)).toBeGreaterThanOrEqual(2);
    expect(Math.min(Math.abs(f0.zEarly), Math.abs(f0.zLate))).toBeGreaterThanOrEqual(1);
    expect(rel.features[0].id).toBe("f0");
  });

  it("marks a sign-flipping feature as unstable", () => {
    const nFeatures = 5;
    const earlyBeta = [0, 1.0, 0, 0, 0];
    const lateBeta = [0, -1.0, 0, 0, 0];
    const { decisions, featureIds } = makeSplitCohort({
      nFeatures,
      nCands: 8,
      decisionsPerGame: 80,
      earlyBeta,
      lateBeta,
      seed: 77,
    });
    const opts = { l2: 1e-3, maxIter: 300, tol: 1e-7 };
    const fitFull = fitBias(decisionsForFit(decisions), opts);
    const rel = reliabilitySplit(decisions, opts, { fitFull, featureIds });
    const f1 = rel.features.find((f) => f.id === "f1");
    expect(f1).toBeDefined();
    expect(f1.signAgree).toBe(false);
    expect(f1.stable).toBe(false);
  });

});