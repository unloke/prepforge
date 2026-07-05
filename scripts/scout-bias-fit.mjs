// Scout v12 — β regression harness: full fit, §7.1 reliability, holdout diagnostic.
//
// Usage:
//   node scripts/scout-bias-fit.mjs <dump.ndjson> [--l2 1e-3] [--report out.json] [--seed 42]

import { readFileSync, writeFileSync } from "node:fs";

import { FEATURE_IDS } from "../web-src/scout-bias-features.js";
import {
  decisionsForFit,
  fitBias,
  heldOutLogLik,
  loadDump,
  reliabilitySplit,
  top1Accuracy,
} from "../web-src/scout-bias-fit.js";

function parseArgs(argv) {
  const out = { l2: 1e-3, seed: 42, positional: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--l2") out.l2 = Number(argv[++i]) || 1e-3;
    else if (a === "--report") out.report = argv[++i];
    else if (a === "--seed") out.seed = Number(argv[++i]) || 42;
    else out.positional.push(a);
  }
  return out;
}

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

function featureIds(header) {
  return header.featureIds || FEATURE_IDS;
}

function sortByAbsZ(fit, ids) {
  return ids
    .map((id, idx) => ({
      id,
      idx,
      beta: fit.beta[idx],
      z: fit.z[idx],
      se: fit.se[idx],
      firing: fit.firingCounts[idx],
    }))
    .sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0));
}

function printTable(rows, limit = 10) {
  console.log("feature                          beta        z   firing");
  for (const r of rows.slice(0, limit)) {
    const beta = Number.isFinite(r.beta) ? r.beta.toFixed(4) : "   n/a";
    const z = Number.isFinite(r.z) ? r.z.toFixed(2) : " n/a";
    const firing = String(r.firing).padStart(6);
    console.log(`${r.id.padEnd(32)} ${beta.padStart(8)} ${z.padStart(8)} ${firing}`);
  }
}

function printStabilityTable(features) {
  const rows = features.filter((f) => Math.abs(f.zFull ?? 0) >= 1);
  if (!rows.length) return;
  console.log("\nTime-split stability (|zFull| ≥ 1):");
  console.log("feature                          βfull   zfull  βearly   βlate  stable");
  for (const r of rows) {
    const betaFull = Number.isFinite(r.betaFull) ? r.betaFull.toFixed(4) : "   n/a";
    const zFull = Number.isFinite(r.zFull) ? r.zFull.toFixed(2) : " n/a";
    const betaEarly = Number.isFinite(r.betaEarly) ? r.betaEarly.toFixed(4) : "   n/a";
    const betaLate = Number.isFinite(r.betaLate) ? r.betaLate.toFixed(4) : "   n/a";
    const mark = r.stable ? "✓" : "";
    console.log(
      `${r.id.padEnd(32)} ${betaFull.padStart(8)} ${zFull.padStart(8)} ${betaEarly.padStart(8)} ${betaLate.padStart(8)} ${mark.padStart(6)}`,
    );
  }
}

function holdoutDiagnostic(decisions, betaZero, opts, seed) {
  const games = [...new Set(decisions.map((d) => d.g))];
  const rng = mulberry32(seed);
  const shuffled = [...games];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const holdN = Math.max(1, Math.floor(games.length * 0.2));
  const holdGames = new Set(shuffled.slice(0, holdN));
  const train = decisions.filter((d) => !holdGames.has(d.g));
  const hold = decisions.filter((d) => holdGames.has(d.g));
  const fit = fitBias(decisionsForFit(train), opts);
  const ho = heldOutLogLik(decisionsForFit(hold), fit.beta);
  const hoRaw = heldOutLogLik(decisionsForFit(hold), betaZero);
  const top1Tilted = top1Accuracy(decisionsForFit(hold), fit.beta);
  const top1Raw = top1Accuracy(decisionsForFit(hold), betaZero);
  const meanLogLossTilted = ho.n ? -ho.model / ho.n : NaN;
  const meanLogLossRaw = hoRaw.n ? -hoRaw.raw / hoRaw.n : NaN;
  return {
    holdGames: holdGames.size,
    trainGames: games.length - holdGames.size,
    holdDecisions: hold.length,
    trainDecisions: train.length,
    meanLogLossTilted,
    meanLogLossRaw,
    deltaLogLoss: meanLogLossTilted - meanLogLossRaw,
    top1Tilted: top1Tilted.rate,
    top1Raw: top1Raw.rate,
    fit,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const dumpPath = args.positional[0];
  if (!dumpPath) {
    console.error("Usage: node scripts/scout-bias-fit.mjs <dump.ndjson> [--l2 1e-3] [--report out.json] [--seed 42]");
    process.exit(1);
  }
  const text = readFileSync(dumpPath, "utf8");
  const { header, decisions } = loadDump(text);
  const ids = featureIds(header);
  const opts = { l2: args.l2 };
  const betaZero = new Array(ids.length).fill(0);

  console.log(`Scout v12 bias fit — ${decisions.length} decisions, ${header.games ?? "?"} games, l2=${args.l2}`);
  if (header.decoy) console.log(`  decoy=${header.decoy}`);

  const fit = fitBias(decisionsForFit(decisions), opts);
  const rows = sortByAbsZ(fit, ids);
  console.log(`\nTop features by |z| (converged=${fit.converged}, iter=${fit.iterations}, logLik=${fit.logLik.toFixed(2)}, raw=${fit.logLikRaw.toFixed(2)}):`);
  printTable(rows, 34);

  const rel = reliabilitySplit(decisions, opts, { fitFull: fit, featureIds: ids });
  console.log(`\n§7.1 reliability (median datestamp=${rel.medianDatestamp}, early ${rel.earlyGames}g/${rel.earlyDecisions}d, late ${rel.lateGames}g/${rel.lateDecisions}d):`);
  console.log(`  Pearson r=${Number.isFinite(rel.r) ? rel.r.toFixed(4) : "n/a"} on ${rel.usedFeatures.length} features (firing≥30 both halves)`);
  if (rel.dropped.length) {
    console.log(`  dropped (${rel.dropped.length}): ${rel.dropped.map((d) => d.id).join(", ")}`);
  }

  const ho = holdoutDiagnostic(decisions, betaZero, opts, args.seed);
  console.log(`\nHoldout diagnostic (seed=${args.seed}, ${ho.holdGames} games / ${ho.holdDecisions} decisions held out):`);
  console.log(`  mean log-loss tilted=${ho.meanLogLossTilted.toFixed(4)} raw=${ho.meanLogLossRaw.toFixed(4)} Δ=${ho.deltaLogLoss.toFixed(4)}`);
  console.log(`  top-1 tilted=${(ho.top1Tilted * 100).toFixed(1)}% raw=${(ho.top1Raw * 100).toFixed(1)}%`);

  console.log("\n--- verdict ---");
  console.log(`reliability r=${Number.isFinite(rel.r) ? rel.r.toFixed(4) : "n/a"}`);
  console.log(`holdout Δlogloss=${ho.deltaLogLoss.toFixed(4)} (tilted − raw, negative = tilted better)`);
  console.log(`top1 raw=${(ho.top1Raw * 100).toFixed(1)}% tilted=${(ho.top1Tilted * 100).toFixed(1)}%`);

  printStabilityTable(rel.features);

  if (args.report) {
    const report = {
      header,
      fit: {
        beta: Object.fromEntries(ids.map((id, i) => [id, fit.beta[i]])),
        se: Object.fromEntries(ids.map((id, i) => [id, fit.se[i]])),
        z: Object.fromEntries(ids.map((id, i) => [id, fit.z[i]])),
        firingCounts: Object.fromEntries(ids.map((id, i) => [id, fit.firingCounts[i]])),
        logLik: fit.logLik,
        logLikRaw: fit.logLikRaw,
        iterations: fit.iterations,
        converged: fit.converged,
        featuresByAbsZ: rows.map((r) => ({
          id: r.id,
          beta: r.beta,
          z: r.z,
          se: r.se,
          firing: r.firing,
        })),
      },
      reliability: {
        r: rel.r,
        medianDatestamp: rel.medianDatestamp,
        usedFeatures: rel.usedFeatures,
        dropped: rel.dropped,
        earlyGames: rel.earlyGames,
        lateGames: rel.lateGames,
        earlyDecisions: rel.earlyDecisions,
        lateDecisions: rel.lateDecisions,
        features: rel.features,
      },
      holdout: {
        seed: args.seed,
        holdGames: ho.holdGames,
        trainGames: ho.trainGames,
        holdDecisions: ho.holdDecisions,
        meanLogLossTilted: ho.meanLogLossTilted,
        meanLogLossRaw: ho.meanLogLossRaw,
        deltaLogLoss: ho.deltaLogLoss,
        top1Tilted: ho.top1Tilted,
        top1Raw: ho.top1Raw,
      },
      verdict: {
        reliabilityR: rel.r,
        holdoutDeltaLogLoss: ho.deltaLogLoss,
        top1Raw: ho.top1Raw,
        top1Tilted: ho.top1Tilted,
      },
    };
    writeFileSync(args.report, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${args.report}`);
  }
}

main();