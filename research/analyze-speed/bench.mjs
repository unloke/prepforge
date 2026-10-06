// Whole-game Analyze speed study: does fishnet-style backward ordering (hash reuse) or a
// shallow-then-deep pass make the main Stockfish pass cheaper, and what does it cost in
// move-grade accuracy? Runs on Kaggle (see package.py), never locally.
//
//   node research/analyze-speed/bench.mjs <games.csv> <out-dir> [games=48] [budget-minutes]
//
// Every arm analyses the same games with the production engine (Stockfish 19 lite, single
// thread, one process per worker, 4 workers like the browser pool) and the production limits
// (depth 16, 1.5M nodes). A depth-20 arm is the reference "truth" the grades are scored against.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { Chess } from "chess.js";

const require = createRequire(import.meta.url);
const ENGINE = join(require.resolve("stockfish/package.json"), "..", "bin", "stockfish-19-lite-single.js");
const WORKERS = 4;
const DEPTH = 16;
const MAX_NODES = 1500000;

// ---- games ------------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h, r[k]])));
}

// Rated games of 40–100 plies, ordered by a hash of the id (a fixed, unbiased sample).
export function sampleGames(csvText, count) {
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  return parseCsv(csvText)
    .filter((g) => /^true$/i.test(g.rated) && Number(g.turns) >= 40 && Number(g.turns) <= 100)
    .sort((a, b) => (hash(a.id) < hash(b.id) ? -1 : 1))
    .slice(0, count)
    .map((g) => {
      const chess = new Chess();
      const positions = [chess.fen()];
      const moves = [];
      for (const san of g.moves.trim().split(/\s+/)) {
        const m = chess.move(san);
        moves.push(m.from + m.to + (m.promotion || ""));
        positions.push(chess.fen());
      }
      return { id: g.id, positions, moves };
    });
}

// ---- engine ------------------------------------------------------------------------------
function createEngine() {
  const proc = spawn(process.execPath, [ENGINE]);
  let buffer = "", pending = null;
  proc.stdout.on("data", (x) => {
    buffer += x;
    if (pending && pending.done(buffer)) {
      const p = pending; pending = null; p.yes(buffer);
    }
  });
  const command = (cmd, done) => new Promise((yes) => {
    buffer = ""; pending = { done, yes };
    proc.stdin.write(cmd + "\n");
  });
  return {
    init: async (hash) => {
      await command("uci", (s) => s.includes("uciok"));
      await command(`setoption name Hash value ${hash}\nisready`, (s) => s.includes("readyok"));
    },
    newGame: () => command("ucinewgame\nisready", (s) => s.includes("readyok")),
    async search(fen, depth, maxNodes) {
      const chess = new Chess(fen);
      if (chess.isGameOver()) {
        const mated = chess.isCheckmate();
        return { cp: mated ? null : 0, mate: null, mated, best: null, depth: 0, nodes: 0, ms: 0 };
      }
      const t0 = performance.now();
      const out = await command(`position fen ${fen}\ngo depth ${depth} nodes ${maxNodes}`, (s) => /(^|\n)bestmove /.test(s));
      const ms = performance.now() - t0;
      let last = null;
      for (const line of out.split(/\r?\n/)) {
        if (!line.startsWith("info depth") || !/ score /.test(line) || / (lower|upper)bound/.test(line)) continue;
        last = line;
      }
      const sign = fen.split(" ")[1] === "w" ? 1 : -1;
      const d = last ? Number(last.match(/info depth (\d+)/)[1]) : 0;
      const nodes = last ? Number((last.match(/ nodes (\d+)/) || [0, 0])[1]) : 0;
      const cp = last && last.match(/score cp (-?\d+)/);
      const mate = last && last.match(/score mate (-?\d+)/);
      const best = (out.match(/bestmove (\S+)/) || [])[1] || null;
      return { cp: cp ? Number(cp[1]) * sign : null, mate: mate ? Number(mate[1]) * sign : null, mated: false, best, depth: d, nodes, ms };
    },
    quit: () => proc.stdin.write("quit\n"),
  };
}

// ---- scheduling ----------------------------------------------------------------------------
// Each order returns a "next job for worker w" function over position indices.
const ORDERS = {
  // Production today: one shared queue, game order, interleaved across workers.
  forward(n) {
    let i = 0;
    return () => (i < n ? i++ : null);
  },
  // Fishnet-style: contiguous blocks taken from the end of the game, each read backwards, so
  // a worker's hash already holds the position that follows the one it is searching.
  backChunks(n, size = 8) {
    const blocks = [];
    for (let end = n; end > 0; end -= size) blocks.push([Math.max(0, end - size), end]);
    const own = new Map();
    return (w) => {
      let q = own.get(w);
      if (!q || !q.length) {
        const b = blocks.shift();
        if (!b) return null;
        q = []; for (let i = b[1] - 1; i >= b[0]; i--) q.push(i);
        own.set(w, q);
      }
      return q.shift();
    };
  },
  // Four static quarters, each backwards (maximal locality, no stealing).
  backQuarters(n) {
    const per = Math.ceil(n / WORKERS);
    const qs = Array.from({ length: WORKERS }, (_, w) => {
      const out = []; for (let i = Math.min(n, (w + 1) * per) - 1; i >= w * per; i--) out.push(i);
      return out;
    });
    return (w) => (qs[w].length ? qs[w].shift() : null);
  },
};

async function runPass(engines, fens, indices, order, depth, owner) {
  const results = new Map();
  const next = order(indices.length);
  await Promise.all(engines.map(async (engine, w) => {
    for (;;) {
      const k = next(w);
      if (k == null) return;
      const i = indices[k];
      results.set(i, await engine.search(fens[i], depth, depth > DEPTH ? MAX_NODES * 4 : MAX_NODES));
      if (owner) owner.set(i, w);
    }
  }));
  return results;
}

// ---- grading -----------------------------------------------------------------------------
const cpToWin = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
function whiteWin(ev) {
  if (ev.mated) return null; // filled by caller from the side to move
  if (ev.mate != null) return ev.mate > 0 ? 100 : ev.mate < 0 ? 0 : 50;
  return cpToWin(Math.max(-1000, Math.min(1000, ev.cp ?? 0)));
}
function winOf(fen, ev) {
  if (ev.mated) return fen.split(" ")[1] === "w" ? 0 : 100;
  return whiteWin(ev);
}
export const TIERS = ["best", "excellent", "good", "inaccuracy", "mistake", "blunder"];
export function grade(game, evals, i) {
  const fen = game.positions[i];
  const white = fen.split(" ")[1] === "w";
  const before = winOf(fen, evals.get(i));
  const after = winOf(game.positions[i + 1], evals.get(i + 1));
  const loss = white ? before - after : after - before;
  if (evals.get(i).best === game.moves[i]) return { tier: "best", loss };
  const tier = loss <= 2 ? "excellent" : loss <= 5 ? "good" : loss <= 10 ? "inaccuracy" : loss <= 15 ? "mistake" : "blunder";
  return { tier, loss };
}

// ---- arms ------------------------------------------------------------------------------------
const ARMS = {
  baseline: { order: "forward", hash: 16 },
  baselineRepeat: { order: "forward", hash: 16 },
  backChunks: { order: "backChunks", hash: 16 },
  backQuarters: { order: "backQuarters", hash: 16 },
  backChunksHash64: { order: "backChunks", hash: 64 },
  // Shallow pass everywhere, then the analysis depth only where a grade could hinge on it.
  tiered1: { order: "backChunks", hash: 16, shallow: 12, lossFlag: 1 },
  tiered3: { order: "backChunks", hash: 16, shallow: 12, lossFlag: 3 },
  reference20: { order: "backChunks", hash: 64, depth: 20 },
};

async function runArm(arm, engines, game) {
  const fens = game.positions;
  const all = fens.map((_, i) => i);
  for (const e of engines) await e.newGame();
  const t0 = performance.now();
  let evals, deepCount = 0;
  if (!arm.shallow) {
    evals = await runPass(engines, fens, all, ORDERS[arm.order], arm.depth || DEPTH);
  } else {
    const owner = new Map();
    evals = await runPass(engines, fens, all, ORDERS[arm.order], arm.shallow, owner);
    const flag = new Set();
    for (let i = 0; i < game.moves.length; i++) {
      const { loss } = grade(game, evals, i);
      const mate = evals.get(i).mate != null || evals.get(i + 1).mate != null;
      if (loss >= arm.lossFlag || mate) { flag.add(i); flag.add(i + 1); }
    }
    // Deep re-reads go back to the worker that searched the position shallow (its hash
    // holds that tree), backwards; an idle worker steals from the busiest list.
    const lists = engines.map(() => []);
    for (const i of [...flag].sort((a, b) => b - a)) lists[owner.get(i) ?? 0].push(i);
    deepCount = flag.size;
    await Promise.all(engines.map(async (engine, w) => {
      for (;;) {
        let list = lists[w];
        if (!list.length) list = lists.reduce((a, b) => (b.length > a.length ? b : a));
        const i = list.shift();
        if (i == null) return;
        evals.set(i, await engine.search(fens[i], DEPTH, MAX_NODES));
      }
    }));
  }
  const wall = performance.now() - t0;
  let nodes = 0, depthSum = 0;
  for (const ev of evals.values()) { nodes += ev.nodes; depthSum += ev.depth; }
  return { wall, nodes, meanDepth: depthSum / fens.length, deepCount, evals };
}

async function main() {
  const [csvPath, outDir, countArg, budgetArg] = process.argv.slice(2);
  // No new game starts once the budget is spent; the games already run are kept.
  const deadline = Date.now() + (Number(budgetArg) || Infinity) * 60000;
  const games = sampleGames(readFileSync(csvPath, "utf8"), Number(countArg) || 48);
  mkdirSync(outDir, { recursive: true });
  const engines = {};
  for (const [name, arm] of Object.entries(ARMS)) {
    engines[name] = Array.from({ length: WORKERS }, createEngine);
    for (const e of engines[name]) await e.init(arm.hash);
  }
  const names = Object.keys(ARMS);
  const rows = [];
  for (const [g, game] of games.entries()) {
    if (Date.now() > deadline) break;
    // Rotate the arm order per game so machine drift doesn't favour one arm.
    const order = names.map((_, k) => names[(k + g) % names.length]);
    const byArm = {};
    for (const name of order) byArm[name] = await runArm(ARMS[name], engines[name], game);
    for (const name of names) {
      const r = byArm[name];
      const grades = game.moves.map((_, i) => grade(game, r.evals, i));
      rows.push({
        game: game.id, arm: name, positions: game.positions.length, wall: Math.round(r.wall), nodes: r.nodes,
        meanDepth: +r.meanDepth.toFixed(2), deepCount: r.deepCount,
        tiers: grades.map((x) => x.tier), losses: grades.map((x) => +x.loss.toFixed(2)),
        evals: game.positions.map((_, i) => { const e = r.evals.get(i); return [e.cp, e.mate, e.best, e.depth]; }),
      });
    }
    console.log(`game ${g + 1}/${games.length} ${game.id} ${names.map((n) => `${n}=${Math.round(byArm[n].wall)}ms`).join(" ")}`);
    writeFileSync(join(outDir, "rows.json"), JSON.stringify(rows));
  }
  for (const list of Object.values(engines)) list.forEach((e) => e.quit());
  writeFileSync(join(outDir, "rows.json"), JSON.stringify(rows));
}

if ((process.argv[1] || "").endsWith("bench.mjs")) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
