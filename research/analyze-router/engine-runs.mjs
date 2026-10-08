// Fixed-depth Stockfish reads with the full iterative-deepening history kept, for the
// deepening-router study (see PROTOCOL.md). Runs on Kaggle (package.py), never locally.
//
//   node engine-runs.mjs <fens.txt> <out.ndjson> --engine lite|<native binary path>
//        --depth N [--nodes 1500000, 0 = no cap] [--hash 16] [--workers 4] [--budget minutes]
//
// One line in, one JSON line out per FEN. Every position starts from `ucinewgame` (no hash
// carried between positions), so a read is a pure function of the FEN and the engine.
// Resumable: FENs already present in <out.ndjson> are skipped.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";

const require = createRequire(import.meta.url);
const LITE = join(require.resolve("stockfish/package.json"), "..", "bin", "stockfish-19-lite-single.js");

// One UCI `info` line → { depth, seldepth, cp, mate, bound, nodes, time, best } (side-to-move POV), or null.
export function parseInfo(line) {
  if (!line.startsWith("info ") || !/ depth /.test(line) || !/ score /.test(line)) return null;
  const num = (key) => {
    const m = line.match(new RegExp(` ${key} (-?\\d+)`));
    return m ? Number(m[1]) : null;
  };
  if (num("multipv") != null && num("multipv") !== 1) return null;
  const pv = line.match(/ pv (\S+)/);
  return {
    depth: num("depth"), seldepth: num("seldepth"), cp: num("cp"), mate: num("mate"),
    bound: / (lower|upper)bound/.test(line), nodes: num("nodes"), time: num("time"), best: pv ? pv[1] : null,
  };
}

// The search history of one `go`: per completed depth the last exact line, plus how many
// bound (fail-high/low) lines that depth printed. Rows: [depth, cp, mate, best, nodes, timeMs, seldepth, bounds].
export function iterations(lines) {
  const byDepth = new Map();
  for (const line of lines) {
    const p = parseInfo(line);
    if (!p || p.depth == null) continue;
    const row = byDepth.get(p.depth) || { exact: null, bounds: 0 };
    if (p.bound) row.bounds += 1;
    else row.exact = p;
    byDepth.set(p.depth, row);
  }
  return [...byDepth.entries()].filter(([, r]) => r.exact).sort((a, b) => a[0] - b[0])
    .map(([d, r]) => [d, r.exact.cp, r.exact.mate, r.exact.best, r.exact.nodes, r.exact.time, r.exact.seldepth, r.bounds]);
}

export function createEngine(path) {
  const proc = path === "lite" ? spawn(process.execPath, [LITE]) : spawn(path);
  let buffer = "", pending = null;
  proc.stdout.on("data", (x) => {
    buffer += x;
    if (pending && pending.done(buffer)) { const p = pending; pending = null; p.yes(buffer); }
  });
  const command = (cmd, done) => new Promise((yes) => { buffer = ""; pending = { done, yes }; proc.stdin.write(cmd + "\n"); });
  return {
    init: async (hash) => {
      await command("uci", (s) => s.includes("uciok"));
      await command(`setoption name Threads value 1\nsetoption name Hash value ${hash}\nisready`, (s) => s.includes("readyok"));
    },
    // fresh=false keeps the hash of the engine's earlier searches, as the browser game pass did.
    async search(fen, depth, nodes, fresh = true) {
      if (fresh) await command("ucinewgame\nisready", (s) => s.includes("readyok"));
      const t0 = performance.now();
      const out = await command(`position fen ${fen}\ngo depth ${depth}${nodes ? ` nodes ${nodes}` : ""}`, (s) => /(^|\n)bestmove /.test(s));
      const ms = performance.now() - t0;
      const lines = out.split(/\r?\n/);
      const best = (out.match(/(^|\n)bestmove (\S+)/) || [])[2] || null;
      return { fen, best: best === "(none)" ? null : best, ms: Math.round(ms * 10) / 10, it: iterations(lines) };
    },
    quit: () => proc.stdin.write("quit\n"),
  };
}

async function main() {
  const [fensPath, outPath, ...rest] = process.argv.slice(2);
  const opt = (k, d) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : d);
  const engine = opt("--engine", "lite"), depth = Number(opt("--depth", 12)), nodes = Number(opt("--nodes", 1500000));
  const hash = Number(opt("--hash", 16)), workers = Number(opt("--workers", 4));
  const deadline = Date.now() + Number(opt("--budget", 0) || Infinity) * 60000;
  const done = new Set();
  if (existsSync(outPath)) for (const l of readFileSync(outPath, "utf8").split("\n")) if (l) done.add(JSON.parse(l).fen);
  const fens = [];
  for await (const l of createInterface({ input: createReadStream(fensPath) })) if (l && !done.has(l)) fens.push(l);
  const engines = Array.from({ length: workers }, () => createEngine(engine));
  for (const e of engines) await e.init(hash);
  let next = 0, count = 0, buffer = [];
  const flush = () => { if (buffer.length) { appendFileSync(outPath, buffer.join("")); buffer = []; } };
  const t0 = Date.now();
  await Promise.all(engines.map(async (e) => {
    while (next < fens.length && Date.now() < deadline) {
      const fen = fens[next++];
      // Await before touching `buffer`: a flush by another worker replaces the array.
      const row = JSON.stringify(await e.search(fen, depth, nodes)) + "\n";
      buffer.push(row);
      if (++count % 2000 === 0) {
        flush();
        console.log(`${outPath}: ${count}/${fens.length} in ${Math.round((Date.now() - t0) / 1000)}s`);
      }
    }
  }));
  flush();
  engines.forEach((e) => e.quit());
  console.log(JSON.stringify({ out: outPath, engine, depth, ran: count, skipped: done.size, remaining: fens.length - count }));
}

if ((process.argv[1] || "").endsWith("engine-runs.mjs")) main().catch((err) => { console.error(err); process.exit(1); });
