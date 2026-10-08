// A whole-game shard: rated datasnaek/chess games of 40–100 plies in the analyze-speed hash
// order, starting at `offset` (the first 48 are that study's sample). Writes games.json and
// the distinct FENs in game order.
//
//   node games.mjs <games.csv> <out-dir> <count> [offset=48]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sampleGames } from "../analyze-speed/bench.mjs";

const [csvPath, outDir, count, offset = 48] = process.argv.slice(2);
const games = sampleGames(readFileSync(csvPath, "utf8"), Number(offset) + Number(count)).slice(Number(offset));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "games.json"), JSON.stringify(games));
const fens = [...new Set(games.flatMap((g) => g.positions))];
writeFileSync(join(outDir, "fens.txt"), fens.join("\n") + "\n");
console.log(JSON.stringify({ offset: Number(offset), games: games.length, positions: games.reduce((a, g) => a + g.positions.length, 0), distinct: fens.length }));
