// Scout v12 §7.2 — decoy dump: resample played move from candidate set (maia or uniform).
//
// Usage:
//   node scripts/scout-bias-decoy.mjs <dump.ndjson> <maia|uniform> [outPath] [--seed 1]

import { readFileSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { seed: 1, positional: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--seed") out.seed = Number(argv[++i]) || 1;
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

const P_FLOOR = 1e-6;

function sampleIndexMaia(cands, rng) {
  let sumP = 0;
  for (const c of cands) sumP += Math.max(c.p, P_FLOOR);
  const u = rng() * sumP;
  let acc = 0;
  for (let i = 0; i < cands.length; i += 1) {
    acc += Math.max(cands[i].p, P_FLOOR);
    if (u <= acc) return i;
  }
  return cands.length - 1;
}

function sampleIndexUniform(cands, rng) {
  return Math.floor(rng() * cands.length);
}

function rewriteDecision(row, mode, rng) {
  const cands = [...row.cands];
  const idx = mode === "uniform" ? sampleIndexUniform(cands, rng) : sampleIndexMaia(cands, rng);
  const picked = cands[idx];
  cands.splice(idx, 1);
  cands.unshift(picked);
  return {
    ...row,
    played: picked.uci,
    cands,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const [dumpPath, mode, outPath] = args.positional;
  if (!dumpPath || (mode !== "maia" && mode !== "uniform")) {
    console.error("Usage: node scripts/scout-bias-decoy.mjs <dump.ndjson> <maia|uniform> [outPath] [--seed 1]");
    process.exit(1);
  }
  const text = readFileSync(dumpPath, "utf8");
  const lines = text.split(/\r?\n/).filter((ln) => ln.trim());
  const header = JSON.parse(lines[0]);
  const rng = mulberry32(args.seed);
  const outLines = [JSON.stringify({ ...header, decoy: mode })];
  for (let i = 1; i < lines.length; i += 1) {
    const row = JSON.parse(lines[i]);
    outLines.push(JSON.stringify(rewriteDecision(row, mode, rng)));
  }
  const output = outLines.join("\n") + "\n";
  const dest = outPath || dumpPath.replace(/\.ndjson$/, `-decoy-${mode}.ndjson`);
  writeFileSync(dest, output);
  console.log(`Wrote ${outLines.length - 1} decisions (${mode} decoy, seed=${args.seed}) → ${dest}`);
}

main();