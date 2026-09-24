// Compare Scout's engine-free candidate order on the same chronological games.
// Usage: node scripts/scout-route-reach-benchmark.mjs <parsed-games.json> [module-path]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const dataPath = process.argv[2];
const modulePath = process.argv[3] || "web-src/scout.js";
if (!dataPath) throw new Error("Pass a parsed Scout games JSON file");
const scout = await import(pathToFileURL(resolve(modulePath)).href);
const games = JSON.parse(readFileSync(dataPath, "utf8"))
  .filter((game) => ["white", "black"].includes(game.color) && game.ucis?.length)
  .sort((a, b) => (a.datestamp || 0) - (b.datestamp || 0));
const sizes = [20, 50, 100, 300, 1000].filter((size) => size <= games.length);
const holdout = games.slice(-Math.min(50, Math.max(0, games.length - sizes.at(-1))));
const profilePool = holdout.length ? games.slice(0, -holdout.length) : games;

function routeReach(trie, ucis, color) {
  const stats = scout.triePrefixStats(trie, ucis);
  if (stats.length !== Math.min(ucis.length, scout.MAX_PLIES)) return 0;
  return stats.reduce((p, node) => {
    const mover = node.ply % 2 === 0 ? "white" : "black";
    return mover === color ? p * node.moveShare : p;
  }, 1);
}

function heldoutDecisionHit(routes, sample) {
  let positions = 0;
  let hits = 0;
  for (const game of sample) {
    for (const route of routes) {
      if (route.color !== game.color) continue;
      for (let ply = 0; ply < route.ucis.length; ply += 1) {
        if ((ply % 2 === 0 ? "white" : "black") !== route.color) continue;
        if (!route.ucis.slice(0, ply).every((move, index) => game.ucis[index] === move)) continue;
        positions += 1;
        if (game.ucis[ply] === route.ucis[ply]) hits += 1;
      }
    }
  }
  return { positions, hits, rate: positions ? Number((hits / positions).toFixed(3)) : null };
}

const rows = sizes.map((size) => {
  const profile = profilePool.slice(-size);
  const selected = [];
  for (const color of ["white", "black"]) {
    const trie = scout.buildOpeningTrie(profile, color, { recency: false });
    const baseline = scout.opponentColorBaseline(profile, color);
    const ranked = scout.rankedOpeningBranches(profile, color, {
      trie, baselineScorePct: baseline, limit: 0,
    }).branches;
    const top = ranked.slice(0, 12);
    selected.push(...top.map((line) => ({
      color,
      ucis: line.ucis,
      reach: line.routeReach ?? routeReach(trie, line.ucis, color),
      prior: line.exploitabilityPrior,
      games: line.games,
    })));
  }
  const reaches = selected.map((line) => line.reach).sort((a, b) => a - b);
  return {
    games: size,
    selected: selected.length,
    medianReach: reaches.length ? Number(reaches[Math.floor(reaches.length / 2)].toFixed(4)) : null,
    belowTwoPercent: selected.filter((line) => line.reach < 0.02).length,
    oneGameRoutes: selected.filter((line) => line.games === 1).length,
    heldout: heldoutDecisionHit(selected, holdout),
    topRoutes: selected.slice(0, 3).map((line) => ({ color: line.color, ucis: line.ucis, reach: Number(line.reach.toFixed(4)) })),
  };
});
console.log(JSON.stringify({ corpus: dataPath, validGames: games.length, holdoutGames: holdout.length, module: modulePath, rows }, null, 2));
