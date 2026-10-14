// Whole-game analysis exactly as the Analyze screen runs it, under Node: production's
// analyzeTiered (depth 16: lite 12 screen, round 9 router, lite 16 deep) over production's
// analyzeGamePositions and Stockfish provider, whose Web Worker is a child process running the
// browser's engine build (stockfish-19-lite.js, threaded lite, default Hash and Threads). Then
// the production Coach (buildMoveFeatures + buildCommentary) on every move from the saved reads,
// as analyze-session.js does for an analysed mainline. Runs on Kaggle (package.py).
//
//   node --import ./research/coach-relations/prod-depth/register.mjs \
//     research/coach-relations/prod-depth/analyze-games.mjs <games.json> <out-dir> [--budget minutes] [--stress]
//
// Writes <out-dir>/evals.jsonl (one row per game: every saved read), cards.jsonl (one row per
// move), health.json (engine processes, stops, drains, timeouts, crashes, leftovers).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { Chess } from "chess.js";

import { analyzeTiered } from "../../../web-src/engine/tiered-analysis.js";
import { analyzeGamePositions } from "../../../web-src/engine/game-analyzer.js";
import { createStockfishWasmProvider, ANALYSIS_MAX_NODES } from "../../../web-src/engine/stockfish-provider.js";
import { buildMoveFeatures, buildCommentary } from "../../../web-src/coach/bundle.js";

const require = createRequire(import.meta.url);
const LITE = join(require.resolve("stockfish/package.json"), "..", "bin", "stockfish-19-lite.js");
const DEPTH = 16; // Settings default; the screen runs at 12 and the router picks the deep reads
const WORKERS = 4; // resolveConcurrency's ceiling

const [gamesPath, outDir, ...rest] = process.argv.slice(2);
const budget = rest.includes("--budget") ? Number(rest[rest.indexOf("--budget") + 1]) : Infinity;
const deadline = Date.now() + budget * 60000;
mkdirSync(outDir, { recursive: true });

// ---- engine health -----------------------------------------------------------------------
const health = {
  spawned: 0, terminated: 0, exitedUnasked: 0, workerErrors: [], stops: 0, drains: [], searches: 0,
  timeouts: [], searchErrors: [], maxSearchMs: 0, gameErrors: [], leftoverAfterGame: 0, games: 0,
};
const live = new Set();

// A Web Worker over a child process: postMessage writes a UCI line, each stdout line comes back
// as a message, terminate() kills the process (the wasm build ignores "quit").
function nodeWorker() {
  const proc = spawn(process.execPath, [LITE], { stdio: ["pipe", "pipe", "ignore"] });
  health.spawned += 1;
  live.add(proc);
  let killed = false, stopAt = null;
  const w = {
    onmessage: null,
    onerror: null,
    postMessage(cmd) {
      if (killed) return;
      if (cmd === "stop") { health.stops += 1; stopAt = performance.now(); }
      proc.stdin.write(cmd + "\n");
    },
    terminate() {
      if (killed) return;
      killed = true;
      health.terminated += 1;
      proc.kill("SIGKILL");
    },
  };
  proc.stdin.on("error", () => {});
  proc.on("error", (err) => { health.workerErrors.push(String(err)); w.onerror?.({ message: String(err) }); });
  proc.on("exit", (code, signal) => {
    live.delete(proc);
    if (!killed) {
      health.exitedUnasked += 1;
      health.workerErrors.push(`engine exited ${code ?? signal}`);
      w.onerror?.({ message: `engine exited ${code ?? signal}` });
    }
  });
  createInterface({ input: proc.stdout }).on("line", (line) => {
    if (killed) return;
    if (stopAt !== null && line.startsWith("bestmove")) {
      health.drains.push(Math.round(performance.now() - stopAt));
      stopAt = null;
    }
    w.onmessage?.({ data: line });
  });
  return w;
}

function createProvider(opts) {
  const p = createStockfishWasmProvider({ ...opts, createWorker: nodeWorker });
  const wait = p.waitForSearchComplete.bind(p);
  p.waitForSearchComplete = async (o) => {
    try {
      const snap = await wait(o);
      const ms = Date.now() - o.started;
      health.maxSearchMs = Math.max(health.maxSearchMs, ms);
      if (ms >= o.timeoutMs) health.timeouts.push({ fen: o.fen, ms, depth: snap.current_depth });
      return snap;
    } catch (err) {
      health.searchErrors.push(String(err));
      throw err;
    }
  };
  return p;
}

const analyze = (o) => {
  health.searches += o.positions.length;
  return analyzeGamePositions({ ...o, concurrency: WORKERS, maxNodes: ANALYSIS_MAX_NODES, createProvider });
};

const settle = async () => {
  for (let i = 0; i < 50 && live.size; i++) await new Promise((r) => setTimeout(r, 100));
  return live.size;
};

// ---- coach ---------------------------------------------------------------------------------
function sans(fen, ucis) {
  const b = new Chess(fen), out = [];
  for (const u of ucis) {
    try { out.push(b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; }
  }
  return out;
}

// savedPositionEvalRead (analyze-session.js): the saved game read as the Coach's one line.
function savedRead(fen, ev) {
  const pvUci = (ev.pv || []).slice();
  const pvSan = sans(fen, pvUci);
  const uci = ev.best_move_uci || pvUci[0] || null;
  return { lines: [{ uci, san: pvSan[0] || uci || "", cp: ev.score_cp ?? null, mate: ev.mate_in ?? null, pvUci, pvSan }] };
}

function cards(game, moves, evals) {
  return moves.map((m, i) => {
    const before = evals.get(m.fen_before), afterEv = evals.get(m.fen_after);
    const c = new Chess(m.fen_after);
    const mover = m.side;
    let top;
    if (c.isCheckmate()) top = { cp: null, mate: mover === "white" ? 1 : -1, pvUci: [], pvSan: [] };
    else if (c.isGameOver()) top = { cp: 0, mate: null, pvUci: [], pvSan: [] };
    else top = savedRead(m.fen_after, afterEv).lines[0];
    const prev = moves[i - 1];
    const f = buildMoveFeatures({
      ply: i + 1, moveNumber: Number(m.fen_before.split(" ")[5]), mover, uci: m.uci, san: m.san,
      prevSan: prev ? prev.san : null, prevUci: prev ? prev.uci : null, prevFenBefore: prev ? prev.fen_before : null,
      fenBefore: m.fen_before, fenAfter: m.fen_after,
      beforeEval: savedRead(m.fen_before, before),
      afterEval: { cp: top.cp ?? null, mate: top.mate ?? null, pvUci: top.pvUci || [], pvSan: top.pvSan || [] },
    });
    const read = (ev) => ev && { cp: ev.score_cp ?? null, mate: ev.mate_in ?? null, depth: ev.depth, nodes: ev.nodes, pv: ev.pv || [] };
    return {
      id: `${game.id}/${i}`, fen: m.fen_before, fenAfter: m.fen_after, uci: m.uci, san: m.san, mover,
      moveNumber: f.moveNumber, code: f.classification.code, bestUci: f.bestUci, bestSan: f.bestSan, isBest: f.isBest,
      before: read(before), after: read(afterEv), prose: buildCommentary(f, { selfSide: mover }).prose,
    };
  });
}

// ---- games ---------------------------------------------------------------------------------
const games = JSON.parse(readFileSync(gamesPath, "utf8"));
const evalsPath = join(outDir, "evals.jsonl"), cardsPath = join(outDir, "cards.jsonl");
const done = new Set();
if (existsSync(evalsPath)) for (const l of readFileSync(evalsPath, "utf8").split("\n")) if (l) done.add(JSON.parse(l).id);
const t0 = Date.now();
for (const game of games) {
  if (Date.now() > deadline) break;
  if (done.has(game.id)) continue;
  const b = new Chess();
  const positions = [b.fen()], moves = [];
  for (const uci of game.moves) {
    const fen_before = b.fen(), side = b.turn() === "w" ? "white" : "black";
    const mv = b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    moves.push({ fen_before, fen_after: b.fen(), side, uci, san: mv.san });
    positions.push(b.fen());
  }
  const tg = Date.now();
  let deep = 0;
  try {
    const { evals, screenDepth } = await analyzeTiered({
      analyze, positions, moves, depth: DEPTH,
      onProgress: (d, t, stage) => { if (stage === "deep") deep = t; },
    });
    const rows = [...evals].map(([fen, ev]) => ({ fen, cp: ev.score_cp, mate: ev.mate_in, depth: ev.depth, nodes: ev.nodes, pv: ev.pv }));
    appendFileSync(evalsPath, JSON.stringify({ id: game.id, screenDepth, deep, ms: Date.now() - tg, evals: rows }) + "\n");
    appendFileSync(cardsPath, cards(game, moves, evals).map((r) => JSON.stringify(r) + "\n").join(""));
  } catch (err) {
    health.gameErrors.push({ id: game.id, error: String(err && err.stack || err) });
  }
  health.games += 1;
  health.leftoverAfterGame = Math.max(health.leftoverAfterGame, await settle());
  if (health.games % 25 === 0) {
    console.log(JSON.stringify({ games: health.games, of: games.length, s: Math.round((Date.now() - t0) / 1000), spawned: health.spawned, live: live.size }));
  }
}

// ---- stress: the per-position timeout, the stop-drain and teardown ------------------------
// Unbounded searches (no node cap, depth 40) hit the 30 s per-position timeout and are taken
// shallow; the next position stops the running search first (a drain); the pass then closes.
if (rest.includes("--stress")) {
  const fens = [
    "r1b2rk1/pp1nqppp/2pbpn2/3p4/2PP4/2NBPN2/PPQ2PPP/R1B2RK1 w - - 0 9",
    "2r2rk1/1bqnbppp/p2ppn2/1p6/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 13",
    "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
  ];
  const ts = Date.now(), before = { timeouts: health.timeouts.length, drains: health.drains.length };
  let stressErr = null;
  try {
    await analyzeGamePositions({ positions: fens, depth: 40, concurrency: 1, maxNodes: null, createProvider });
  } catch (err) { stressErr = String(err); }
  health.stress = {
    seconds: Math.round((Date.now() - ts) / 1000), error: stressErr,
    timeouts: health.timeouts.length - before.timeouts, drains: health.drains.slice(before.drains),
    leftover: await settle(),
  };
}

const sorted = health.drains.slice().sort((a, b) => a - b);
writeFileSync(join(outDir, "health.json"), JSON.stringify({
  ...health, drains: undefined,
  drainCount: sorted.length, drainP50: sorted[Math.floor(sorted.length / 2)] ?? null, drainMax: sorted.at(-1) ?? null,
  liveAtEnd: await settle(), seconds: Math.round((Date.now() - t0) / 1000),
}, null, 1));
console.log(JSON.stringify({ out: outDir, games: health.games, seconds: Math.round((Date.now() - t0) / 1000) }));
process.exit(0);
