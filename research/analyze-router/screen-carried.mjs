// Depth-12 screen reads as the browser game pass makes them (PROTOCOL.md amendment 7): each game's
// distinct positions, in order, go through one shared queue to four engines; an engine keeps its
// hash from one position to the next and starts each game empty. Finished games (checkmate,
// stalemate) never reach an engine, as in game-analyzer.js. A FEN shared by several games keeps
// its first game's read. Same output rows as engine-runs.mjs. Runs on Kaggle (job.py), never locally.
//
//   node screen-carried.mjs <games.json> <out.ndjson> [--budget minutes]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { Chess } from "chess.js";

import { createEngine } from "./engine-runs.mjs";

const [gamesPath, outPath, ...rest] = process.argv.slice(2);
const budget = rest.includes("--budget") ? Number(rest[rest.indexOf("--budget") + 1]) : Infinity;
const deadline = Date.now() + budget * 60000;
const STREAMS = 4, DEPTH = 12, NODES = 1500000, HASH = 16;
const games = JSON.parse(readFileSync(gamesPath, "utf8"));
const engines = [];
for (let i = 0; i < STREAMS; i++) {
  const e = createEngine("lite");
  await e.init(HASH);
  engines.push(e);
}

function terminal(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { fen, best: null, ms: 0, it: [[0, null, 0, null, null, null, null, 0]] };
  if (c.isStalemate()) return { fen, best: null, ms: 0, it: [[0, 0, null, null, null, null, null, 0]] };
  return null;
}

writeFileSync(outPath, "");
const seen = new Set();
const t0 = Date.now();
let done = 0, reads = 0;
for (const game of games) {
  if (Date.now() > deadline) break;
  const fens = [...new Set(game.positions)];
  const out = new Map();
  let next = 0;
  await Promise.all(engines.map(async (e) => {
    let first = true;
    while (next < fens.length) {
      const fen = fens[next++];
      const t = terminal(fen);
      if (t) { out.set(fen, t); continue; }
      out.set(fen, await e.search(fen, DEPTH, NODES, first));
      first = false;
    }
  }));
  const rows = fens.filter((f) => !seen.has(f)).map((f) => JSON.stringify(out.get(f)) + "\n");
  fens.forEach((f) => seen.add(f));
  appendFileSync(outPath, rows.join(""));
  done += 1;
  reads += fens.length;
  if (done % 50 === 0) console.log(`${outPath}: ${done}/${games.length} games, ${reads} reads in ${Math.round((Date.now() - t0) / 1000)}s`);
}
engines.forEach((e) => e.quit());
console.log(JSON.stringify({ out: outPath, games: done, of: games.length, distinct: seen.size, seconds: Math.round((Date.now() - t0) / 1000) }));
