// Real-position check for both sides of the Analyze coach's move reads.
//
// Replays public games from tests/fixtures/scout/ericrosen-selection.json through
// Stockfish 19 lite (Node, MultiPV 2 before / 1 after, fixed depth), builds the same
// move features the live coach uses, and prints, for every move, the
// opponent read next to the own read; actualRead records the fixture user?s side.
// Engine reads are cached in tmp/coach-opponent-evals.json so reruns are offline.
//
//   node scripts/coach/opponent-read-sample.mjs [--games N] [--depth D] [--only-tactical] [--quiet]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Chess } from "chess.js";
import { buildMoveFeatures, buildCommentary } from "../../web-src/coach/bundle.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const GAMES = Number(arg("--games", 8));
const DEPTH = Number(arg("--depth", 14));
const ONLY_TACTICAL = process.argv.includes("--only-tactical");
const cacheFile = resolve("tmp/coach-opponent-evals.json");
mkdirSync(resolve("tmp"), { recursive: true });
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};

let engine = null;
let buffer = "";
let pending = null;
function startEngine() {
  engine = spawn(process.execPath, [resolve("node_modules/stockfish/bin/stockfish-19-lite-single.js")]);
  engine.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (pending && pending.done(buffer)) pending.resolve(buffer);
  });
}
function command(cmd, done) {
  return new Promise((res) => {
    buffer = "";
    pending = { done, resolve: (out) => { pending = null; res(out); } };
    engine.stdin.write(`${cmd}\n`);
  });
}

function uciToSan(fen, ucis) {
  const chess = new Chess(fen);
  const out = [];
  for (const u of ucis) {
    try {
      const mv = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
      out.push(mv.san);
    } catch (_) {
      break;
    }
  }
  return out;
}

async function evaluate(fen, multipv) {
  const key = `${DEPTH}|${multipv}|${fen}`;
  if (cache[key]) return cache[key];
  if (!engine) {
    startEngine();
    await command("uci", (s) => s.includes("uciok"));
  }
  await command(`setoption name MultiPV value ${multipv}\nisready`, (s) => s.includes("readyok"));
  const out = await command(`position fen ${fen}\ngo depth ${DEPTH}`, (s) => s.includes("bestmove"));
  const black = fen.split(" ")[1] === "b";
  const lines = [];
  for (const row of out.split("\n")) {
    const m = /^info .*\bdepth (\d+) .*\bmultipv (\d+) .*\bscore (cp|mate) (-?\d+).*? pv (.+)$/.exec(row.trim());
    if (!m || Number(m[1]) !== DEPTH) continue;
    const rank = Number(m[2]);
    let value = Number(m[4]);
    if (black) value = -value;
    const pvUci = m[5].trim().split(/\s+/);
    lines[rank - 1] = {
      uci: pvUci[0],
      san: uciToSan(fen, pvUci.slice(0, 1))[0] || pvUci[0],
      cp: m[3] === "cp" ? value : null,
      mate: m[3] === "mate" ? value : null,
      pvUci,
      pvSan: uciToSan(fen, pvUci),
    };
  }
  const read = { lines: lines.filter(Boolean) };
  cache[key] = read;
  return read;
}

const games = JSON.parse(readFileSync("tests/fixtures/scout/ericrosen-selection.json", "utf8"))
  .filter((g) => g.ucis.length >= 30)
  .slice(0, GAMES);

const rows = [];
for (const game of games) {
  const chess = new Chess();
  let prev = null;
  // `game.color` is the opponent's colour in the Scout fixture; the "user" is the other side.
  const selfSide = game.color === "white" ? "black" : "white";
  for (let i = 0; i < game.ucis.length; i++) {
    const fenBefore = chess.fen();
    const uci = game.ucis[i];
    const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
    const fenAfter = chess.fen();
    const mover = mv.color === "w" ? "white" : "black";
    {
      const before = await evaluate(fenBefore, 2);
      const after = chess.isGameOver() ? { lines: [{ cp: chess.isCheckmate() ? null : 0, mate: chess.isCheckmate() ? (mover === "white" ? 1 : -1) : null, pvUci: [], pvSan: [] }] } : await evaluate(fenAfter, 1);
      const top = after.lines[0] || {};
      const features = buildMoveFeatures({
        ply: i + 1,
        moveNumber: Number(fenBefore.split(" ")[5]),
        mover,
        uci,
        san: mv.san,
        prevSan: prev?.san ?? null,
        prevUci: prev?.uci ?? null,
        prevFenBefore: prev?.fenBefore ?? null,
        fenBefore,
        fenAfter,
        beforeEval: { lines: before.lines },
        afterEval: { cp: top.cp ?? null, mate: top.mate ?? null, pvUci: top.pvUci || [], pvSan: top.pvSan || [] },
      });
      const own = buildCommentary({ ...features }, { selfSide: mover }).prose;
      const opp = buildCommentary({ ...features, opponentRead: true }, { selfSide: mover === "white" ? "black" : "white" });
      rows.push({ features, uci, mover, selfSide, actualRead: mover === selfSide ? "own" : "opponent", playedPv: features.playedPvUci, bestPv: features.bestPvUci, game: game.gameId, ply: i + 1, san: mv.san, code: features.classification.code, grade: opp.grade, tone: opp.tone, opponent: opp.prose, own, fenBefore });
    }
    prev = { san: mv.san, uci, fenBefore };
  }
  writeFileSync(cacheFile, JSON.stringify(cache));
  writeFileSync(resolve("tmp/coach-precision-rows.json"), JSON.stringify({ depth: DEPTH, games: games.indexOf(game) + 1, rows }, null, 2));
  console.error(`Finished game ${rows.at(-1)?.game}: ${rows.length} moves`);
}
if (engine) engine.kill();
writeFileSync(cacheFile, JSON.stringify(cache));

writeFileSync(resolve("tmp/coach-precision-rows.json"), JSON.stringify({ depth: DEPTH, games: games.length, rows }, null, 2));

const tactical = /\b(wins?|drops?|hangs?|hanging|forks?|pins?|skewers?|mate|misses|threat|attacks?|hits?|takes)\b/;
let shown = 0;
for (const r of rows) {
  if (process.argv.includes("--quiet")) continue;
  if (ONLY_TACTICAL && !tactical.test(r.own) && !["mistake", "blunder", "inaccuracy"].includes(r.code)) continue;
  shown += 1;
  console.log(`${r.game} ply ${r.ply} ${r.san} [${r.code}]`);
  console.log(`  opponent: ${r.opponent}`);
  console.log(`  own-read: ${r.own}`);
}
const concrete = rows.filter((r) => tactical.test(r.opponent)).length;
const ownConcrete = rows.filter((r) => tactical.test(r.own)).length;
console.log(`\n${rows.length} total moves (both sides); legacy tactical-keyword opponent reads ${concrete}, own reads ${ownConcrete}; shown ${shown}`);
