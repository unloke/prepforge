// Production engine (Stockfish 19 lite-single, depth 8, Hash 16) over UCI with node accounting.
import { spawn } from "node:child_process";
import { Chess } from "chess.js";
import { parseFinalDepthScore } from "../lib/scout-stockfish-uci.js";

export const DEPTH = 8;

/** Nodes searched by the final completed iteration of one `go` (cumulative for that search). */
export function parseNodes(uci, depth = DEPTH) {
  let nodes = null;
  for (const line of uci.split(/\r?\n/)) {
    const d = line.match(/^info depth (\d+) /), n = line.match(/ nodes (\d+)/);
    if (d && n && Number(d[1]) >= depth) nodes = Number(n[1]);
  }
  return nodes;
}

/** White-POV result of a finished search or a game-over position. */
export function interpret(fen, uci, depth = DEPTH) {
  const chess = new Chess(fen);
  if (chess.isGameOver()) {
    const winner = chess.isCheckmate() ? (chess.turn() === "w" ? "black" : "white") : null;
    return { whiteCp: winner ? null : 0, whiteMate: null, winner, nodes: 0, terminal: true };
  }
  const score = parseFinalDepthScore(uci, depth);
  if (!score) throw Error(`incomplete depth${depth}: ${fen}`);
  const sign = fen.split(" ")[1] === "w" ? 1 : -1;
  return { whiteCp: score.type === "cp" ? score.cp * sign : null, whiteMate: score.type === "mate" ? score.value * sign : null,
    winner: null, nodes: parseNodes(uci, depth) ?? 0, terminal: false };
}

export async function createEngine(enginePath, { hashMiB = 16 } = {}) {
  const proc = spawn(process.execPath, [enginePath]);
  let pending = null, buffer = "";
  proc.stdout.on("data", x => { buffer += x; if (pending?.done(buffer)) pending.finish(buffer); });
  proc.stderr.on("data", x => process.stderr.write(x));
  const command = (cmd, done) => new Promise((yes, no) => {
    const timer = setTimeout(() => { pending = null; no(Error("UCI timeout")); }, 120000);
    buffer = ""; pending = { done, finish: s => { clearTimeout(timer); pending = null; yes(s); } };
    proc.stdin.write(cmd + "\n");
  });
  await command("uci", s => s.includes("uciok"));
  await command(`setoption name Hash value ${hashMiB}\nisready`, s => s.includes("readyok"));
  const engine = {
    searches: 0,
    newLine: () => command("ucinewgame\nisready", s => s.includes("readyok")),
    async read(fen, depth = DEPTH) {
      if (new Chess(fen).isGameOver()) return interpret(fen, "", depth);
      const uci = await command(`position fen ${fen}\ngo depth ${depth}`, s => /(^|\n)bestmove /.test(s));
      engine.searches++;
      return { ...interpret(fen, uci, depth), uci };
    },
    // v10 leaf semantics: a fresh game for every read.
    async fresh(fen) { await engine.newLine(); return engine.read(fen); },
    quit: () => proc.stdin.write("quit\n"),
  };
  return engine;
}
