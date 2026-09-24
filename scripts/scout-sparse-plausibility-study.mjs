// Sparse-decision candidate study on parsed public Scout games.
// Usage: node scripts/scout-sparse-plausibility-study.mjs tmp/scout-player.json
import { readFileSync } from "node:fs";
import { Chess } from "chess.js";
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

function evidence(route, minParentGames, probabilityGate) {
  const supported = route.decisions.filter((decision) => decision.parentGames >= minParentGames);
  const unknown = route.decisions.length - supported.length;
  const low = supported.filter((decision) => decision.probability < probabilityGate);
  return { supported: supported.length, unknown, low: low.length,
    minSupportedProbability: supported.length ? Math.min(...supported.map((decision) => decision.probability)) : null,
    deepestSupportedPly: supported.length ? supported.at(-1).ply + 1 : null };
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
  for (const minParentGames of [1, 2, 3, 5]) for (const probabilityGate of [0.05, 0.1, 0.15]) {
    // min=1, gate=.10 is the PR #74 baseline.
    const annotated = routes.map((route) => ({ route, evidence: evidence(route, minParentGames, probabilityGate) }));
    const eligible = annotated.filter(({ evidence: item }) => !item.low);
    if (minParentGames === 3 && probabilityGate === 0.1) {
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
    const supported = selected.reduce((sum, item) => sum + item.evidence.supported, 0);
    const unknown = selected.reduce((sum, item) => sum + item.evidence.unknown, 0);
    const deepest = selected.map((item) => item.evidence.deepestSupportedPly).filter(Number.isFinite)
      .sort((a, b) => a - b);
    rows.push({ games: size, minParentGames, probabilityGate, candidateCount: eligible.length,
      selectedRoutes: selected.map(({ route }) => `${route.color}:${route.ucis.join(">")}`),
      heldout: heldoutHit(selected.map(({ route }) => route)),
      selectedSupportedDecisions: supported, selectedUnknownDecisions: unknown,
      deepestSupportedPly: deepest.at(-1) ?? null,
      medianDeepestSupportedPly: deepest[Math.floor(deepest.length / 2)] ?? null,
      lowProbabilityRejectedRoutes: annotated.length - eligible.length,
      stockfishLeafFens: leafFens.size, maiaMax: Math.min(enginePool.length, 12) });
    if (size === sizes.at(-1) && minParentGames === 3 && probabilityGate === 0.1) {
      const examples = [
        ...selected.slice(0, 2),
        ...annotated.filter(({ evidence: item }) => item.low > 0).slice(0, 1),
      ];
      traces.push(...examples.map(({ route, evidence: routeEvidence }) => ({
        color: route.color, route: route.sans.join(" "), plies: route.ucis.length,
        evidence: routeEvidence,
        decisions: route.decisions.map((decision) => ({ ...decision,
          evidence: decision.parentGames >= minParentGames ? "supported" : "unknown",
          gate: decision.parentGames < minParentGames ? "unknown" :
            decision.probability < probabilityGate ? "reject" : "pass" })),
      })));
    }
  }
}
console.log(JSON.stringify({ source, validGames: games.length, holdoutGames: holdout.length,
  baseline: { minParentGames: 1, probabilityGate: 0.1 }, rows, traces }, null, 2));
