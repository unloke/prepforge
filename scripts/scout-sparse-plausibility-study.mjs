// Sparse-decision candidate study on parsed public Scout games.
// Usage: node scripts/scout-sparse-plausibility-study.mjs tmp/scout-player.json
import { readFileSync } from "node:fs";
import { Chess } from "chess.js";
import { opponentMoveProbability } from "../web-src/scout-probability.js";
import {
  aggregateOpeningBranches, buildOpeningTrie, branchExploitabilityPrior,
  branchStruggle, opponentColorBaseline, rankedOpeningBranches, triePrefixStats, trimRankedBranches,
} from "../web-src/scout.js";

const source = process.argv[2];
if (!source) throw new Error("Pass parsed games JSON");
const games = JSON.parse(readFileSync(source, "utf8"))
  .filter((game) => ["white", "black"].includes(game.color) && game.ucis?.length)
  .sort((a, b) => (a.datestamp || 0) - (b.datestamp || 0));
const holdout = games.slice(-50);
const pool = games.slice(0, -50);
const sizes = [20, 50, 100, 300, 1000].filter((size) => size <= pool.length);

function routeDecisions(trie, route, color) {
  const stats = triePrefixStats(trie, route.ucis);
  const board = new Chess();
  return route.ucis.map((move, ply) => {
    const position = board.fen();
    board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    if ((ply % 2 === 0 ? "white" : "black") !== color) return null;
    const node = stats[ply];
    const moveGames = node?.gameCount || 0;
    const probability = node?.moveShare || 0;
    return { ply, position, move, parentGames: node?.parentGames || 0,
      moveGames, probability };
  }).filter(Boolean);
}

function evidence(route, method, probabilityGate) {
  const estimates = route.decisions.map((decision) => opponentMoveProbability(
    decision.moveGames, decision.parentGames, method,
  ));
  return { low: estimates.filter((value) => value < probabilityGate).length,
    weakestEstimate: estimates.length ? Math.min(...estimates) : null,
    deepestDecisionPly: route.decisions.at(-1)?.ply + 1 ?? null };
}

function leafFen(route) {
  const board = new Chess();
  for (const move of route.ucis) board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
  return board.fen();
}

function heldoutHit(routes) {
  let positions = 0; let hits = 0;
  for (const route of routes) for (const game of holdout) {
    if (game.color !== route.color) continue;
    for (const decision of route.decisions) {
      if (!route.ucis.slice(0, decision.ply).every((move, index) => game.ucis[index] === move)) continue;
      positions++;
      if (game.ucis[decision.ply] === decision.move) hits++;
    }
  }
  return { positions, hits, rate: positions ? +(hits / positions).toFixed(3) : null };
}

const rows = [];
const traces = [];
for (const size of sizes) {
  const profile = pool.slice(-size);
  const routes = [];
  const tries = {};
  const baselines = {};
  for (const color of ["white", "black"]) {
    const trie = buildOpeningTrie(profile, color, { maxPlies: Infinity, recency: false });
    const baseline = opponentColorBaseline(profile, color);
    tries[color] = trie;
    baselines[color] = baseline;
    for (const branch of aggregateOpeningBranches(profile, color).branches) {
      const { struggle, prefixGames } = branchStruggle(trie, branch.ucis, baseline);
      const prior = branchExploitabilityPrior({ ...branch, exploitabilityStruggle: struggle, prefixGames },
        { trie, baselineScorePct: baseline });
      routes.push({ ...branch, color, prior, decisions: routeDecisions(trie, branch, color) });
    }
  }
  routes.sort((a, b) => b.prior - a.prior || b.branchScore - a.branchScore);
  for (const method of ["raw", "laplace", "jeffreys", "wilson"]) for (const probabilityGate of [0.1]) {
    const annotated = routes.map((route) => ({ route, evidence: evidence(route, method, probabilityGate) }));
    const eligible = annotated.filter(({ evidence: item }) => !item.low);
    if (method === "jeffreys" && probabilityGate === 0.1) {
      for (const color of ["white", "black"]) {
        const expected = new Set(eligible.filter(({ route }) => route.color === color)
          .map(({ route }) => route.ucis.join(">")));
        const production = rankedOpeningBranches(profile, color, {
          trie: tries[color], baselineScorePct: baselines[color], limit: 0,
        }).branches;
        if (production.length !== expected.size ||
          production.some((route) => !expected.has(route.ucis.join(">")))) {
          throw new Error(`Production candidate gate disagrees with benchmark: ${color}, ${size} games`);
        }
      }
    }
    const selected = eligible.slice(0, 24);
    const enginePool = ["white", "black"].flatMap((color) => trimRankedBranches(
      eligible.filter(({ route }) => route.color === color)
        .map(({ route }) => ({ ...route, exploitabilityPrior: route.prior })),
    ));
    const leafFens = new Set(enginePool.map(leafFen));
    const decisionCount = selected.reduce((sum, item) => sum + item.route.decisions.length, 0);
    const deepest = selected.map((item) => item.evidence.deepestDecisionPly).filter(Number.isFinite)
      .sort((a, b) => a - b);
    rows.push({ games: size, method, probabilityGate, candidateCount: eligible.length,
      selectedRoutes: selected.map(({ route }) => `${route.color}:${route.ucis.join(">")}`),
      selectedRouteCount: selected.length,
      veryLowRawRoutes: eligible.filter(({ route }) => route.decisions.some((decision) =>
        decision.probability < 0.05)).length,
      heldout: heldoutHit(selected.map(({ route }) => route)),
      selectedDecisionCount: decisionCount,
      selectedRouteMedianPly: [...selected.map(({ route }) => route.ucis.length)].sort((a,b)=>a-b)[Math.floor(selected.length/2)] ?? null,
      deepestDecisionPly: deepest.at(-1) ?? null,
      lowProbabilityRejectedRoutes: annotated.length - eligible.length,
      stockfishLeafFens: leafFens.size, maiaMax: Math.min(enginePool.length, 12) });
    if (size === sizes.at(-1) && method === "jeffreys" && probabilityGate === 0.1) {
      const examples = [
        ...selected.slice(0, 2),
        ...annotated.filter(({ evidence: item }) => item.low > 0).slice(0, 1),
      ];
      traces.push(...examples.map(({ route, evidence: routeEvidence }) => ({
        color: route.color, route: route.sans.join(" "), plies: route.ucis.length,
        evidence: routeEvidence,
        decisions: route.decisions.map((decision) => ({ ...decision,
          estimate: opponentMoveProbability(decision.moveGames, decision.parentGames, method),
          gate: opponentMoveProbability(decision.moveGames, decision.parentGames, method) < probabilityGate
            ? "reject" : "pass" })),
      })));
    }
  }
}
console.log(JSON.stringify({ source, validGames: games.length, holdoutGames: holdout.length,
  probabilityGate: 0.1, rows, traces }, null, 2));
