// Router features of one position from what the screen pass already has: the FEN and the
// screen read's iteration history. One implementation, used both to build the training
// table (train.py) and to time the browser cost (infer-bench.mjs).
//
//   node features.mjs <reads.ndjson> <out.ndjson>     (reads: engine-runs.mjs rows)
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { Chess } from "chess.js";

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
// Side-to-move win chance (0..100) of an iteration row's score.
function win(cp, mate) {
  const c = mate != null ? (mate > 0 ? 1000 : -1000) : Math.max(-1000, Math.min(1000, cp ?? 0));
  return 100 / (1 + Math.exp(-0.00368208 * c));
}

export const FEATURES = [
  "win", "absCp", "mate", "mateDist", "range8", "d12_11", "d12_10", "d12_8", "bestChanges", "stableSince",
  "logNodes", "branch", "seldepthGap", "legal", "inCheck", "captures", "checks", "material", "balance", "queens", "ply",
];

// it: rows [depth, cp, mate, best, nodes, timeMs, seldepth, bounds], side-to-move POV.
export function positionFeatures(fen, it) {
  const game = new Chess(fen);
  // Plain SAN, not verbose moves: verbose objects cost ~10x more, and SAN alone gives captures
  // ("x") and checks ("+"/"#").
  const moves = game.moves();
  let material = 0, balance = 0, queens = 0;
  const stm = game.turn();
  for (const row of game.board()) for (const sq of row) {
    if (!sq) continue;
    material += VALUE[sq.type];
    balance += sq.color === stm ? VALUE[sq.type] : -VALUE[sq.type];
    if (sq.type === "q") queens += 1;
  }
  const last = it[it.length - 1] || [0, 0, null, null, 1, 0, 0, 0];
  const at = (d) => it.find((r) => r[0] === d) || last;
  const w = (r) => win(r[1], r[2]);
  const deep = it.filter((r) => r[0] >= 8);
  const ws = deep.map(w);
  let changes = 0, stable = last[0];
  for (let i = 1; i < it.length; i++) if (it[i][0] >= 6 && it[i][3] !== it[i - 1][3]) changes += 1;
  for (let i = it.length - 1; i >= 0 && it[i][3] === last[3]; i--) stable = it[i][0];
  const prev = it.length > 1 ? it[it.length - 2] : last;
  return [
    w(last), Math.min(1000, Math.abs(last[1] ?? 1000)) / 1000, last[2] != null ? 1 : 0, last[2] != null ? Math.abs(last[2]) : 0,
    ws.length ? Math.max(...ws) - Math.min(...ws) : 0,
    Math.abs(w(last) - w(at(11))), Math.abs(w(last) - w(at(10))), Math.abs(w(last) - w(at(8))),
    changes, stable,
    Math.log10(Math.max(1, last[4] ?? 1)), Math.log2(Math.max(1, last[4] ?? 1) / Math.max(1, prev[4] ?? 1)),
    (last[6] ?? last[0]) - last[0],
    moves.length, game.inCheck() ? 1 : 0, moves.filter((m) => m.includes("x")).length, moves.filter((m) => m.includes("+") || m.includes("#")).length,
    material, balance, queens, Number(fen.split(" ")[5]) * 2 - (stm === "w" ? 2 : 1),
  ];
}

async function main() {
  const [readsPath, outPath] = process.argv.slice(2);
  const out = [];
  let n = 0, ms = 0;
  for await (const line of createInterface({ input: createReadStream(readsPath) })) {
    if (!line) continue;
    const r = JSON.parse(line);
    const t0 = performance.now();
    const f = positionFeatures(r.fen, r.it);
    ms += performance.now() - t0; n += 1;
    out.push(JSON.stringify([r.fen, f]));
  }
  writeFileSync(outPath, out.join("\n") + "\n");
  console.log(JSON.stringify({ out: outPath, positions: n, usPerPosition: +((ms * 1000) / Math.max(1, n)).toFixed(1) }));
}

if ((process.argv[1] || "").endsWith("features.mjs")) main().catch((err) => { console.error(err); process.exit(1); });
