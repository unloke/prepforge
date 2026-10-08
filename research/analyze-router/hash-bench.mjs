// The browser screen pass with a fresh hash per position (what the shipped router reads, as
// in training) against the hash carried between positions (the game pass before it). Four
// engines take the positions of each game round-robin, like the browser's worker pool. Both
// modes run on the same games, alternating which goes first. Runs on Kaggle (job.py hashbench).
//
//   node hash-bench.mjs <games.json> <out.json> [games=100]
import { readFileSync, writeFileSync } from "node:fs";

import { Chess } from "chess.js";

import { moveRows, score } from "../../web-src/engine/deepening-router.js";
import { createEngine } from "./engine-runs.mjs";

const [gamesPath, outPath, count = 100] = process.argv.slice(2);
const model = JSON.parse(readFileSync(new URL("../../web-src/engine/deepening-router-model.json", import.meta.url), "utf8"));
const games = JSON.parse(readFileSync(gamesPath, "utf8")).slice(0, Number(count));
const STREAMS = 4, DEPTH = 12, NODES = 1500000;
const engines = { fresh: [], carried: [] };
for (const mode of Object.keys(engines)) {
  for (let i = 0; i < STREAMS; i++) {
    const e = createEngine("lite");
    await e.init(16);
    engines[mode].push(e);
  }
}

// A browser-shaped eval (White POV plus the history rows) from one engine read.
function browserEval(fen, r) {
  const sign = fen.split(" ")[1] === "w" ? 1 : -1;
  const last = r.it[r.it.length - 1];
  return {
    score_cp: last[1] == null ? null : last[1] * sign, mate_in: last[2] == null ? null : last[2] * sign,
    best_move_uci: r.best, depth: last[0],
    iterations: r.it.map((x) => ({ depth: x[0], cp: x[1], mate: x[2], best: x[3], nodes: x[4], seldepth: x[6] })),
  };
}

async function screen(game, mode) {
  const fens = [...new Set(game.positions)];
  const evals = new Map();
  let nodes = 0, cpuMs = 0;
  const t0 = performance.now();
  await Promise.all(engines[mode].map(async (e, k) => {
    for (let i = k; i < fens.length; i += STREAMS) {
      const fen = fens[i];
      const c = new Chess(fen);
      if (c.isCheckmate() || c.isStalemate()) {
        evals.set(fen, { score_cp: 0, mate_in: null, best_move_uci: null, depth: 0 });
        continue;
      }
      // A carried hash still starts each game empty.
      const r = await e.search(fen, DEPTH, NODES, mode === "fresh" || i === k);
      nodes += r.it[r.it.length - 1][4] ?? 0;
      cpuMs += r.ms;
      evals.set(fen, browserEval(fen, r));
    }
  }));
  return { evals, nodes, cpuMs, wallMs: performance.now() - t0 };
}

const total = { fresh: { nodes: 0, cpuMs: 0, wallMs: 0, deep: 0 }, carried: { nodes: 0, cpuMs: 0, wallMs: 0, deep: 0 } };
let moves = 0, agree = 0, flaggedFresh = 0, flaggedCarried = 0, positions = 0;
for (const [gi, game] of games.entries()) {
  const order = gi % 2 ? ["carried", "fresh"] : ["fresh", "carried"];
  const run = {};
  for (const mode of order) run[mode] = await screen(game, mode);
  const ms = game.moves.map((uci, i) => ({
    uci, side: game.positions[i].split(" ")[1] === "w" ? "white" : "black", fen_before: game.positions[i], fen_after: game.positions[i + 1],
  }));
  const flags = {};
  for (const mode of order) {
    const rows = moveRows(ms, run[mode].evals);
    flags[mode] = rows.map((x) => score(model, x) >= model.threshold);
    const deep = new Set(ms.flatMap((m, i) => (flags[mode][i] ? [m.fen_before, m.fen_after] : [])));
    Object.assign(total[mode], {
      nodes: total[mode].nodes + run[mode].nodes, cpuMs: total[mode].cpuMs + run[mode].cpuMs,
      wallMs: total[mode].wallMs + run[mode].wallMs, deep: total[mode].deep + deep.size,
    });
  }
  positions += new Set(game.positions).size;
  moves += ms.length;
  flags.fresh.forEach((f, i) => { agree += f === flags.carried[i]; flaggedFresh += f; flaggedCarried += flags.carried[i]; });
  if ((gi + 1) % 10 === 0) console.log(JSON.stringify({ games: gi + 1, carriedVsFreshCpu: +(total.carried.cpuMs / total.fresh.cpuMs).toFixed(3) }));
}
for (const list of Object.values(engines)) list.forEach((e) => e.quit());
const result = {
  games: games.length, positions, moves, total,
  carriedVsFresh: {
    nodes: total.carried.nodes / total.fresh.nodes, cpuMs: total.carried.cpuMs / total.fresh.cpuMs, wallMs: total.carried.wallMs / total.fresh.wallMs,
  },
  moveFlagAgreement: agree / moves, flaggedMoveShare: { fresh: flaggedFresh / moves, carried: flaggedCarried / moves },
  deepPositionShare: { fresh: total.fresh.deep / positions, carried: total.carried.deep / positions },
};
writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
