// moveCounts against chess.js SAN counting (the pre-amendment-14 feature code) on every FEN of a file.
//
//   node counts-check.mjs <fens.txt>
import { readFileSync } from "node:fs";

import { Chess } from "chess.js";

import { moveCounts } from "./features.mjs";

const fens = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
let mismatches = 0;
for (const fen of fens) {
  const game = new Chess(fen);
  const san = game.moves();
  const want = [san.length, san.filter((m) => m.includes("x")).length, san.filter((m) => m.includes("+") || m.includes("#")).length];
  if (moveCounts(game).join() !== want.join()) mismatches += 1;
}
console.log(JSON.stringify({ positions: fens.length, mismatches }));
