import { branchExploitabilityPrior, branchStruggle } from "../research/scout-legacy-prior.js";
// Candidate-stage comparison on parsed public games, with chronological holdout.
// Usage: node scripts/scout-plausibility-study.mjs tmp/scout-player.json
import { readFileSync } from "node:fs";
import { Chess } from "chess.js";
import {
  aggregateOpeningBranches, buildOpeningTrie,
  opponentColorBaseline, triePrefixStats, trimRankedBranches,
} from "../web-src/scout.js";

const source = process.argv[2];
if (!source) throw new Error("Pass parsed games JSON");
const games = JSON.parse(readFileSync(source, "utf8"))
  .filter((g) => ["white", "black"].includes(g.color) && g.ucis?.length)
  .sort((a, b) => (a.datestamp || 0) - (b.datestamp || 0));
const holdout = games.slice(-50);
const pool = games.slice(0, -50);
const sizes = [20, 50, 100, 300, 1000].filter((n) => n <= pool.length);
const threshold = 0.1;

function decisions(trie, route, color) {
  const stats = triePrefixStats(trie, route.ucis);
  const chess = new Chess();
  return route.ucis.map((uci, ply) => {
    const fen = chess.fen();
    try { chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { /* trace still reports the position */ }
    if ((ply % 2 === 0 ? "white" : "black") !== color) return null;
    const node = stats[ply];
    return { ply, position: fen, move: uci, parentGames: node?.gameCount && node.moveShare ? Math.round(node.gameCount / node.moveShare) : 0, moveGames: node?.gameCount || 0, probability: node?.moveShare || 0 };
  }).filter(Boolean);
}

function metrics(ds) {
  const ps = ds.map((d) => d.probability);
  if (!ps.length) return { min: 0, lower: 0, geometric: 0, product: 0, legacy16: 0 };
  const sorted = [...ps].sort((a, b) => a - b);
  return { min: sorted[0], lower: sorted[Math.floor((sorted.length - 1) * 0.2)],
    geometric: ps.some((p) => !p) ? 0 : Math.exp(ps.reduce((sum, p) => sum + Math.log(p), 0) / ps.length),
    product: ps.reduce((a, b) => a * b, 1),
    legacy16: ds.filter((d) => d.ply < 16).reduce((p, d) => p * d.probability, 1) };
}

function leafFen(route) {
  const chess = new Chess();
  try {
    for (const uci of route.ucis) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return chess.fen();
  } catch { return null; }
}

function heldoutHit(routes) {
  let positions = 0; let hits = 0;
  for (const route of routes) for (const game of holdout) {
    if (game.color !== route.color) continue;
    for (const d of route.decisions) {
      if (!route.ucis.slice(0, d.ply).every((uci, i) => game.ucis[i] === uci)) continue;
      positions++;
      if (game.ucis[d.ply] === d.move) hits++;
    }
  }
  return positions ? +(hits / positions).toFixed(3) : null;
}

const rows = [];
let traces = [];
for (const size of sizes) {
  const profile = pool.slice(-size);
  const all = [];
  for (const color of ["white", "black"]) {
    const trie = buildOpeningTrie(profile, color, { maxPlies: Infinity, recency: false });
    const baseline = opponentColorBaseline(profile, color);
    const branches = aggregateOpeningBranches(profile, color).branches;
    for (const branch of branches) {
      const ds = decisions(trie, branch, color);
      const { struggle, prefixGames } = branchStruggle(trie, branch.ucis, baseline);
      all.push({ ...branch, color, decisions: ds, scores: metrics(ds),
        prior: branchExploitabilityPrior({ ...branch, exploitabilityStruggle: struggle, prefixGames }, { trie, baselineScorePct: baseline }) });
    }
  }
  all.sort((a, b) => b.prior - a.prior || b.branchScore - a.branchScore);
  for (const method of ["legacy16", "product", "min", "lower", "geometric"]) {
    const floor = ["legacy16", "product"].includes(method) ? 0.02 : threshold;
    const eligible = all.filter((r) => r.scores[method] >= floor);
    const selected = eligible.slice(0, 24);
    const enginePool = ["white", "black"].flatMap((color) => trimRankedBranches(
      eligible.filter((r) => r.color === color).map((r) => ({ ...r, exploitabilityPrior: r.prior })),
    ));
    const leafFens = new Set(enginePool.map(leafFen).filter(Boolean));
    const depths = selected.map((r) => r.ucis.length).sort((a, b) => a - b);
    rows.push({ games: size, method, candidateCount: eligible.length, selected: selected.length,
      absurd: selected.filter((r) => r.scores.min < 0.02).length,
      veryLow: selected.filter((r) => r.scores.min < 0.1).length,
      heldoutDecisionHit: heldoutHit(selected), medianPlies: depths[Math.floor(depths.length / 2)] ?? null,
      stockfishLeafFens: leafFens.size, maiaMax: Math.min(enginePool.length, 12) });
    if (size === sizes.at(-1) && method === "min") traces = [
      ...selected.slice(0, 2),
      ...all.filter((r) => r.scores.min < threshold && r.scores.legacy16 >= 0.02 && r.ucis.length > 16).slice(0, 1),
    ].map((r) => ({
      color: r.color, route: r.sans.join(" "), plies: r.ucis.length, scores: r.scores,
      decisions: r.decisions.map((d) => ({ ...d, gate: d.probability >= threshold ? "pass" : "reject" })),
    }));
  }
}
console.log(JSON.stringify({ source, validGames: games.length, holdoutGames: holdout.length, threshold, rows, traces }, null, 2));
