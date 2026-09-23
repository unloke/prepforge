// Offline, chronological Scout benchmark. No production imports or ranking changes.
// Usage: node scripts/scout-offline-benchmark.mjs tmp/scout-benchmark-*.json
import { readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";

const MAX_PLY = 16;
const TRAIN_SIZES = [10, 20, 40, 80];
const K = 5;
const key = (moves) => moves.join(" ");
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function orderedGames(path) {
  return JSON.parse(readFileSync(path, "utf8"))
    .filter((g) => g.color && Array.isArray(g.ucis) && g.ucis.length >= 4)
    .sort((a, b) => String(a.datestamp || "").localeCompare(String(b.datestamp || "")));
}

function countMap(games, context) {
  const map = new Map();
  for (const game of games) {
    const moves = [];
    for (let ply = 0; ply < Math.min(MAX_PLY, game.ucis.length); ply++) {
      if ((ply % 2 === 0 ? "white" : "black") === game.color) {
        const k = context(moves, game, ply);
        const bucket = map.get(k) || new Map();
        bucket.set(game.ucis[ply], (bucket.get(game.ucis[ply]) || 0) + 1);
        map.set(k, bucket);
      }
      moves.push(game.ucis[ply]);
    }
  }
  return map;
}

function distribution(game, ply, moves, legal, maps, method, fen) {
  const prior = maps.population.get(String(ply % 2)) || new Map();
  const exact = maps.exact.get(key(moves)) || new Map();
  const suffix = maps.suffix.get(key(moves.slice(-Math.min(4, moves.length)))) || new Map();
  const source = method === "suffix" ? suffix : exact;
  const strength = method === "population" || method === "maia" ? 0 : method === "suffix" ? 16 : 8;
  const legalSum = (m) => legal.reduce((s, move) => s + (m.get(move) || 0), 0);
  const denominator = legalSum(source) + strength;
  const populationDenominator = legalSum(prior) + legal.length;
  const maiaRows = maps.maia?.[`${fen.split(" ").slice(0, 4).join(" ")}|${maps.rating}`] || [];
  const maia = new Map(maiaRows.map(({ uci, p }) => [uci, p]));
  const maiaDenominator = legalSum(maia) + legal.length * 1e-6;
  return legal.map((move) => {
    const smokePrior = ((prior.get(move) || 0) + 1) / populationDenominator;
    const maiaPrior = ((maia.get(move) || 0) + 1e-6) / maiaDenominator;
    const fallback = method.startsWith("maia") ? maiaPrior : smokePrior;
    return [move, denominator && method !== "population" && method !== "maia"
      ? ((source.get(move) || 0) + strength * fallback) / denominator : fallback];
  }).sort((a, b) => b[1] - a[1]);
}

function evaluateMoves(test, maps, method) {
  const rows = [];
  for (const game of test) {
    const board = new Chess();
    const moves = [];
    for (let ply = 0; ply < Math.min(MAX_PLY, game.ucis.length); ply++) {
      const actual = game.ucis[ply];
      if ((ply % 2 === 0 ? "white" : "black") === game.color) {
        const legal = board.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ""));
        const probabilities = distribution(game, ply, moves, legal, maps, method, board.fen());
        const p = probabilities.find(([move]) => move === actual)?.[1] || 1e-9;
        rows.push({
          top1: probabilities[0]?.[0] === actual ? 1 : 0,
          top3: probabilities.slice(0, 3).some(([move]) => move === actual) ? 1 : 0,
          top5: probabilities.slice(0, 5).some(([move]) => move === actual) ? 1 : 0,
          logLoss: -Math.log(p),
          brier: probabilities.reduce((s, [move, q]) => s + (q - (move === actual ? 1 : 0)) ** 2, 0),
        });
      }
      try { board.move({ from: actual.slice(0, 2), to: actual.slice(2, 4), promotion: actual[4] }); }
      catch { break; }
      moves.push(actual);
    }
  }
  return Object.fromEntries(["top1", "top3", "top5", "logLoss", "brier"].map((m) => [m, mean(rows.map((r) => r[m]))]));
}

function routeCandidates(train, maps, method) {
  const candidates = new Map();
  for (const game of train) {
    const board = new Chess();
    const moves = [];
    const probs = [];
    for (let ply = 0; ply < Math.min(10, game.ucis.length); ply++) {
      const actual = game.ucis[ply];
      if ((ply % 2 === 0 ? "white" : "black") === game.color) {
        const legal = board.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ""));
        probs.push(distribution(game, ply, moves, legal, maps, method, board.fen()).find(([m]) => m === actual)?.[1] || 1e-9);
      }
      try { board.move({ from: actual.slice(0, 2), to: actual.slice(2, 4), promotion: actual[4] }); }
      catch { break; }
      moves.push(actual);
      if (probs.length >= 2 && ply >= 5 && (ply % 2 === 0 ? "white" : "black") !== game.color) {
        const route = { color: game.color, moves: [...moves], decisions: probs.length,
          product: probs.reduce((a, b) => a * b, 1), geometric: Math.exp(mean(probs.map(Math.log))) };
        candidates.set(game.color + ":" + key(moves), route);
      }
    }
  }
  return [...candidates.values()];
}

function selectRoutes(candidates, score) {
  const ranked = [...candidates].sort((a, b) => b[score] - a[score]);
  const selected = [];
  for (const route of ranked) {
    if (selected.some((s) => s.color === route.color &&
      (key(s.moves).startsWith(key(route.moves)) || key(route.moves).startsWith(key(s.moves))))) continue;
    selected.push(route);
    if (selected.length === K) break;
  }
  return selected;
}

function evaluateRoutes(routes, test, maps, method) {
  const positions = new Map();
  const entered = new Set();
  for (const [routeIndex, route] of routes.entries()) {
    const board = new Chess();
    for (let ply = 0; ply < route.moves.length; ply++) {
      if ((ply % 2 === 0 ? "white" : "black") === route.color) {
        const fen = board.fen();
        const k = `${route.color}:${fen.split(" ").slice(0, 4).join(" ")}`;
        const entry = positions.get(k) || { routes: new Set(), moves: new Set() };
        entry.routes.add(routeIndex);
        entry.moves.add(route.moves[ply]);
        positions.set(k, entry);
      }
      const move = route.moves[ply];
      board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    }
  }
  const observed = [];
  let allDecisions = 0;
  const strictHits = [];
  for (const game of test) {
    strictHits.push(routes.some((r) => r.color === game.color &&
      r.moves.every((move, i) => game.ucis[i] === move)) ? 1 : 0);
    const board = new Chess();
    const moves = [];
    for (let ply = 0; ply < Math.min(MAX_PLY, game.ucis.length); ply++) {
      const actual = game.ucis[ply];
      if ((ply % 2 === 0 ? "white" : "black") === game.color) {
        allDecisions++;
        const k = `${game.color}:${board.fen().split(" ").slice(0, 4).join(" ")}`;
        const entry = positions.get(k);
        if (entry) {
          for (const index of entry.routes) entered.add(index);
          const legal = board.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ""));
          const probabilities = distribution(game, ply, moves, legal, maps, method, board.fen());
          observed.push({
            routeHit: entry.moves.has(actual) ? 1 : 0,
            top1: probabilities[0]?.[0] === actual ? 1 : 0,
            top3: probabilities.slice(0, 3).some(([m]) => m === actual) ? 1 : 0,
            top5: probabilities.slice(0, 5).some(([m]) => m === actual) ? 1 : 0,
          });
        }
      }
      try { board.move({ from: actual.slice(0, 2), to: actual.slice(2, 4), promotion: actual[4] }); }
      catch { break; }
      moves.push(actual);
    }
  }
  return {
    decisionPositionCoverage: allDecisions ? observed.length / allDecisions : null,
    coveredDecisionsPerGame: test.length ? observed.length / test.length : null,
    conditionalRouteMoveHit: mean(observed.map((r) => r.routeHit)),
    conditionalTop1: mean(observed.map((r) => r.top1)),
    conditionalTop3: mean(observed.map((r) => r.top3)),
    conditionalTop5: mean(observed.map((r) => r.top5)),
    falsePrepRate: mean(observed.map((r) => 1 - r.routeHit)),
    unenteredRouteRate: routes.length ? 1 - entered.size / routes.length : null,
    strictFullLineGameHit: mean(strictHits),
    meanRoutePly: mean(routes.map((r) => r.moves.length)),
  };
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex < 0 ? null : args.splice(outIndex, 2)[1];
const maiaPaths = [];
for (let i = 0; i < args.length;) {
  if (args[i] === "--maia-cache") maiaPaths.push(args.splice(i, 2)[1]);
  else i++;
}
const paths = args;
if (!paths.length) throw new Error("Pass one or more fetched Scout JSON files");
const datasets = paths.map((path, index) => {
  const maia = maiaPaths[index] ? JSON.parse(readFileSync(maiaPaths[index], "utf8")) : null;
  const rating = maia ? Number(Object.keys(maia)[0]?.split("|").at(-1)) : null;
  return { path, games: orderedGames(path), maia, rating };
});
const output = datasets.map(({ path, games }, playerIndex) => {
  const pool = datasets.filter((_, i) => i !== playerIndex).flatMap((d) => d.games.slice(0, 80));
  const sizes = TRAIN_SIZES.filter((n) => n + 10 <= games.length).map((n) => {
    const train = games.slice(0, n);
    const test = games.slice(n, Math.min(n + 20, games.length));
    const maps = {
      population: countMap(pool, (_, _g, ply) => String(ply % 2)),
      exact: countMap(train, (moves) => key(moves)),
      suffix: countMap(train, (moves) => key(moves.slice(-Math.min(4, moves.length)))),
      maia: datasets[playerIndex].maia,
      rating: datasets[playerIndex].rating,
    };
    const methods = Object.fromEntries([
      "population", "exact", "suffix", ...(maps.maia ? ["maia", "maiaResidual"] : []),
    ].map((method) => {
      const candidates = routeCandidates(train, maps, method);
      const byColor = Object.fromEntries(["white", "black"].map((color) => {
        const colorCandidates = candidates.filter((route) => route.color === color);
        const colorTest = test.filter((game) => game.color === color);
        return [color, {
          testGames: colorTest.length,
          product: evaluateRoutes(selectRoutes(colorCandidates, "product"), colorTest, maps, method),
          geometric: evaluateRoutes(selectRoutes(colorCandidates, "geometric"), colorTest, maps, method),
          recommendations: selectRoutes(colorCandidates, "geometric").map((r) => ({ color: r.color, moves: r.moves })),
        }];
      }));
      return [method, { move: evaluateMoves(test, maps, method),
        byColor,
        product: evaluateRoutes(["white", "black"].flatMap((color) =>
          selectRoutes(candidates.filter((route) => route.color === color), "product")), test, maps, method),
        geometric: evaluateRoutes(Object.values(byColor).flatMap((group) => group.recommendations), test, maps, method),
        recommendations: Object.values(byColor).flatMap((group) => group.recommendations),
      }];
    }));
    return { trainGames: n, testGames: test.length, methods };
  });
  const methods = Object.keys(sizes[0]?.methods || {});
  const stability = Object.fromEntries(methods.map((method) => [method, sizes.slice(1).map((size, index) => {
    const entries = (sample) => new Set(sample.methods[method].recommendations
      .map((route) => `${route.color}:${key(route.moves.slice(0, 4))}`));
    const before = entries(sizes[index]);
    const after = entries(size);
    const union = new Set([...before, ...after]);
    const byColor = Object.fromEntries(["white", "black"].map((color) => {
      const previous = new Set([...before].filter((entry) => entry.startsWith(`${color}:`)));
      const current = new Set([...after].filter((entry) => entry.startsWith(`${color}:`)));
      const colorUnion = new Set([...previous, ...current]);
      return [color, colorUnion.size ? [...previous].filter((entry) => current.has(entry)).length / colorUnion.size : null];
    }));
    return { from: sizes[index].trainGames, to: size.trainGames,
      entryJaccard: union.size ? [...before].filter((entry) => after.has(entry)).length / union.size : null,
      byColor };
  })]));
  return { player: path, games: games.length, sizes, stability };
});
const report = JSON.stringify({ protocol: "scout-offline-benchmark-v2", maxPly: MAX_PLY, topK: K,
  pressure: "see companion Stockfish WDL report",
  maia: maiaPaths.length === paths.length ? "Maia3 rating-conditioned fp16 cache" : "partial or unavailable", players: output }, null, 2);
if (outPath) writeFileSync(outPath, report + "\n");
else console.log(report);
