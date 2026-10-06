// Summarize research/analyze-speed rows.json: cost per arm and grade accuracy against the
// depth-20 reference (and agreement with today's baseline, next to its own repeat noise).
//   node research/analyze-speed/summarize.mjs <out-dir>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const rows = JSON.parse(readFileSync(join(dir, "rows.json"), "utf8"));
const TIERS = ["best", "excellent", "good", "inaccuracy", "mistake", "blunder"];
const rank = (t) => TIERS.indexOf(t);
const byGame = new Map();
for (const r of rows) {
  if (!byGame.has(r.game)) byGame.set(r.game, {});
  byGame.get(r.game)[r.arm] = r;
}
const games = [...byGame.values()].filter((g) => g.reference20 && g.baseline);
const arms = Object.keys(games[0]);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function compare(arm, ref) {
  let moves = 0, exact = 0, errorFlagAgree = 0, major = 0, eligibleAgree = 0, lossAbs = 0;
  for (const g of games) {
    const a = g[arm], b = g[ref];
    a.tiers.forEach((t, i) => {
      const u = b.tiers[i];
      moves++;
      if (t === u) exact++;
      if ((rank(t) >= 3) === (rank(u) >= 3)) errorFlagAgree++;
      if (Math.abs(rank(t) - rank(u)) >= 2 && Math.max(rank(t), rank(u)) >= 3) major++;
      if ((rank(t) <= 1) === (rank(u) <= 1)) eligibleAgree++;
      lossAbs += Math.abs(a.losses[i] - b.losses[i]);
    });
  }
  const pct = (x) => +(100 * x / moves).toFixed(2);
  return { moves, exactPct: pct(exact), errorFlagAgreePct: pct(errorFlagAgree), majorPct: pct(major), eligibleAgreePct: pct(eligibleAgree), meanAbsLoss: +(lossAbs / moves).toFixed(3) };
}

const base = Object.fromEntries(["wall", "nodes"].map((k) => [k, games.reduce((s, g) => s + g.baseline[k], 0)]));
const summary = { games: games.length, positions: games.reduce((s, g) => s + g.baseline.positions, 0), arms: {} };
for (const arm of arms) {
  const wall = games.reduce((s, g) => s + g[arm].wall, 0);
  const nodes = games.reduce((s, g) => s + g[arm].nodes, 0);
  summary.arms[arm] = {
    wallSec: +(wall / 1000).toFixed(1),
    wallVsBaseline: +(wall / base.wall).toFixed(3),
    medianGameWallRatio: +median(games.map((g) => g[arm].wall / g.baseline.wall)).toFixed(3),
    nodesVsBaseline: +(nodes / base.nodes).toFixed(3),
    meanDepth: +(games.reduce((s, g) => s + g[arm].meanDepth, 0) / games.length).toFixed(2),
    deepShare: +(games.reduce((s, g) => s + g[arm].deepCount, 0) / summary.positions).toFixed(3),
    vsReference20: compare(arm, "reference20"),
    vsBaseline: compare(arm, "baseline"),
  };
}
writeFileSync(join(dir, "SUMMARY.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
