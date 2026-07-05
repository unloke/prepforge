import { describe, expect, it } from "vitest";

import {
  decisionsForFit,
  fitBias,
  heldOutLogLik,
  loadDump,
  samplePlayedFromMaia,
  samplePlayedFromModel,
  solveSpd,
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

function makeSyntheticDecision(nFeatures, nCands, beta, rng) {
  const cands = [];
  for (let i = 0; i < nCands; i += 1) {
    const p = 0.001 + rng() * 0.5;
    cands.push({ p, f: randomSparseFeatures(nFeatures, rng) });
  }
  for (let fi = 0; fi < nFeatures; fi += 1) {
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

describe("solveSpd", () => {
  it("solves a known 3×3 system", () => {
    const n = 3;
    const A = new Float64Array([
      4, 1, 0,
      1, 3, 1,
      0, 1, 2,
    ]);
    const b = new Float64Array([1, 2, 3]);
    const x = solveSpd(A, b, n);
    expect(x).not.toBeNull();
    const Ax = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let j = 0; j < n; j += 1) sum += A[i * n + j] * x[j];
      Ax[i] = sum;
    }
    for (let i = 0; i < n; i += 1) expect(Ax[i]).toBeCloseTo(b[i], 10);
  });
});

describe("fitBias synthetic recovery", () => {
  it("recovers known β within tolerance", () => {
    const nFeatures = 10;
    const nDecisions = 3000;
    const nCands = 8;
    const trueBeta = [0, 0.5, -0.5, 1.2, -1.2, 0, 0, 0, 0.5, 0];
    const rng = mulberry32(42);
    const decisions = [];
    for (let d = 0; d < nDecisions; d += 1) {
      decisions.push(makeSyntheticDecision(nFeatures, nCands, trueBeta, rng));
    }
    const fit = fitBias(decisions, { l2: 1e-3, maxIter: 300, tol: 1e-7 });
    expect(fit.converged).toBe(true);
    for (let f = 0; f < nFeatures; f += 1) {
      if (trueBeta[f] === 0) {
        expect(Math.abs(fit.z[f])).toBeLessThan(3);
      } else {
        expect(fit.beta[f]).toBeCloseTo(trueBeta[f], 0);
        expect(Math.abs(fit.beta[f] - trueBeta[f])).toBeLessThan(0.15);
      }
    }
  });
});

describe("fitBias Maia-decoy null", () => {
  it("finds no significant features when played ∝ raw Maia", () => {
    const nFeatures = 10;
    const nDecisions = 3000;
    const nCands = 8;
    const rng = mulberry32(7);
    const decisions = [];
    for (let d = 0; d < nDecisions; d += 1) {
      const cands = [];
      for (let i = 0; i < nCands; i += 1) {
        cands.push({ p: 0.001 + rng() * 0.5, f: randomSparseFeatures(nFeatures, rng) });
      }
      const playedIdx = samplePlayedFromMaia(cands, rng);
      const picked = cands[playedIdx];
      cands.splice(playedIdx, 1);
      cands.unshift(picked);
      decisions.push({ cands, playedIdx: 0 });
    }
    const fit = fitBias(decisions, { l2: 1e-3 });
    for (let f = 0; f < nFeatures; f += 1) {
      expect(Math.abs(fit.z[f])).toBeLessThan(3);
    }
    const delta = fit.logLik - fit.logLikRaw;
    expect(delta / nDecisions).toBeLessThan(0.01);
  });
});

describe("fitBias constant feature robustness", () => {
  it("keeps β≈0 for a feature that never varies within decisions", () => {
    const nFeatures = 5;
    const rng = mulberry32(99);
    const decisions = [];
    for (let d = 0; d < 500; d += 1) {
      const cands = [];
      const constVal = rng() < 0.5 ? 0 : 1;
      for (let i = 0; i < 6; i += 1) {
        const f = [rng() < 0.3 ? 1 : 0, constVal, rng() < 0.3 ? 1 : 0, rng() < 0.3 ? 1 : 0, rng() < 0.3 ? 1 : 0];
        cands.push({ p: 0.01 + rng() * 0.4, f });
      }
      const playedIdx = samplePlayedFromMaia(cands, rng);
      const picked = cands[playedIdx];
      cands.splice(playedIdx, 1);
      cands.unshift(picked);
      decisions.push({ cands, playedIdx: 0 });
    }
    const fit = fitBias(decisions, { l2: 1e-3 });
    expect(fit.converged).toBe(true);
    expect(Math.abs(fit.beta[1])).toBeLessThan(0.05);
    expect(fit.firingCounts[1]).toBe(0);
  });
});

describe("loadDump", () => {
  it("parses NDJSON with header and decisions", () => {
    const text = [
      '{"featureIds":["a","b"],"rating":1800,"games":1}',
      '{"g":"g1","ply":0,"color":"white","epd":"fen","played":"e2e4","cands":[{"uci":"e2e4","p":0.6,"f":[1,0]},{"uci":"d2d4","p":0.4,"f":[0,1]}],"meta":{"datestamp":1000}}',
    ].join("\n");
    const { header, decisions } = loadDump(text);
    expect(header.featureIds).toEqual(["a", "b"]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].played).toBe("e2e4");
    expect(decisions[0].cands[0].uci).toBe("e2e4");
    expect(decisions[0].meta.datestamp).toBe(1000);
    const fit = fitBias(decisionsForFit(decisions));
    expect(fit.beta).toHaveLength(2);
  });
});

describe("heldOutLogLik", () => {
  it("matches raw Maia at β=0", () => {
    const decisions = [
      {
        cands: [
          { p: 0.6, f: [1, 0] },
          { p: 0.4, f: [0, 1] },
        ],
        playedIdx: 0,
      },
    ];
    const beta = [0, 0];
    const ho = heldOutLogLik(decisions, beta);
    expect(ho.model).toBeCloseTo(ho.raw, 10);
    expect(ho.n).toBe(1);
  });
});