// Offline pressure audit for routes emitted by scout-offline-benchmark.mjs.
// Uses the installed Stockfish lite UCI binary; never imports production ranking.
// Usage: node scripts/scout-wdl-benchmark.mjs tmp/scout-offline-results.json --out tmp/scout-wdl-results.json
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Chess } from "chess.js";
import { pressureMetrics } from "./scout-benchmark-metrics.mjs";

const args = process.argv.slice(2);
const input = args[0];
const outIndex = args.indexOf("--out");
const outPath = outIndex < 0 ? null : args[outIndex + 1];
const maiaPaths = args.flatMap((arg, index) => arg === "--maia-cache" ? [args[index + 1]] : []);
if (!input) throw new Error("Pass an offline benchmark report");

const enginePath = resolve("node_modules/stockfish/bin/stockfish-19-lite-single.js");
const engine = spawn(process.execPath, [enginePath], { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
let pending = null;
let latestWdl = null;
engine.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    const match = line.match(/\bwdl (\d+) (\d+) (\d+)/);
    if (match) latestWdl = match.slice(1).map(Number);
    if (line.startsWith("bestmove ") && pending) {
      pending(latestWdl);
      pending = null;
    }
  }
});
engine.stderr.on("data", (chunk) => process.stderr.write(chunk));
engine.stdin.write("uci\nsetoption name UCI_ShowWDL value true\nisready\n");

const scoreCache = new Map();
async function evaluate(fen) {
  if (scoreCache.has(fen)) return scoreCache.get(fen);
  latestWdl = null;
  const result = await new Promise((resolveWdl, reject) => {
    const timeout = setTimeout(() => { pending = null; reject(new Error("Stockfish timeout")); }, 15000);
    pending = (wdl) => { clearTimeout(timeout); resolveWdl(wdl); };
    engine.stdin.write(`position fen ${fen}\ngo depth 10\n`);
  });
  scoreCache.set(fen, result);
  return result;
}

const report = JSON.parse(readFileSync(input, "utf8"));
const audited = [];
try {
  for (const [playerIndex, player] of report.players.entries()) {
    const largest = player.sizes.at(-1);
    if (!largest) continue;
    const policy = maiaPaths[playerIndex] ? JSON.parse(readFileSync(maiaPaths[playerIndex], "utf8")) : null;
    const rating = policy ? Object.keys(policy)[0]?.split("|").at(-1) : null;
    for (const method of ["maia", "maiaResidual", "exact"]) {
    if (!largest.methods[method]) continue;
    for (const route of largest.methods[method].recommendations) {
      const moves = route.moves;
      const board = new Chess();
      const wdl = [];
      const alternatives = [];
      for (let ply = 0; ply < moves.length; ply++) {
        const move = moves[ply];
        board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
        const value = await evaluate(board.fen());
        if (!value) throw new Error("Stockfish returned no WDL");
        // UCI WDL is from side-to-move perspective.
        wdl.push((board.turn() === "w" ? value[0] + value[1] / 2
          : value[2] + value[1] / 2) / 1000);
        const nextMover = board.turn() === "w" ? "white" : "black";
        if (policy && nextMover === route.color) {
          const epd = board.fen().split(" ").slice(0, 4).join(" ");
          const replies = (policy[`${epd}|${rating}`] || []).filter((r) => r.p >= 0.05).slice(0, 3);
          for (const reply of replies) {
            const branch = new Chess(board.fen());
            try { branch.move({ from: reply.uci.slice(0, 2), to: reply.uci.slice(2, 4), promotion: reply.uci[4] }); }
            catch { continue; }
            const branchWdl = await evaluate(branch.fen());
            if (!branchWdl) continue;
            const whiteWdl = (branch.turn() === "w" ? branchWdl[0] + branchWdl[1] / 2
              : branchWdl[2] + branchWdl[1] / 2) / 1000;
            alternatives.push({ probability: reply.p,
              userWdl: route.color === "white" ? 1 - whiteWdl : whiteWdl });
          }
        }
      }
      audited.push({ player: player.player, method, trainGames: largest.trainGames, moves,
        wdl, alternatives, metrics: pressureMetrics(wdl, route.color, alternatives) });
    }
    }
  }
} finally {
  engine.stdin.write("quit\n");
}
const result = JSON.stringify({ protocol: "scout-wdl-benchmark-v1", stockfish: "19 lite single, depth 10",
  note: "Robustness uses up to three Maia replies with p >= 0.05 after each prepared move.", routes: audited }, null, 2);
if (outPath) writeFileSync(outPath, result + "\n");
else console.log(result);
