// Node Stockfish UCI pool — shared by scout-bias-routes and scout-route-audit harnesses.

import { spawn } from "node:child_process";

import { Chess } from "chess.js";

/** Parse the final-depth score from a `go depth` buffer (single PV). */
export function parseFinalDepthScore(buf, targetDepth) {
  const lines = buf.split(/\r?\n/).filter((ln) => ln.includes("info depth"));
  let best = null;
  for (const line of lines) {
    const dm = line.match(/info depth (\d+)/);
    if (!dm) continue;
    const d = Number(dm[1]);
    if (d < targetDepth) continue;
    const mate = line.match(/score mate (-?\d+)/);
    const cp = line.match(/score cp (-?\d+)/);
    if (mate) best = { depth: d, type: "mate", value: Number(mate[1]) };
    else if (cp) best = { depth: d, type: "cp", cp: Number(cp[1]) };
  }
  return best || { type: "cp", cp: 0 };
}

/** Parse `bestmove` from a `go` buffer. */
export function parseBestMove(buf) {
  const lines = buf.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/^bestmove\s+(\S+)/);
    if (m && m[1] !== "(none)") return m[1];
  }
  return null;
}

/**
 * Parse MultiPV lines at target depth.
 * @returns {Array<{ multipv: number, score: object, pv: string[] }>}
 */
export function parseMultipvAtDepth(buf, targetDepth, multipv = 2) {
  const lines = buf.split(/\r?\n/).filter((ln) => ln.includes("info depth"));
  const byPv = new Map();
  for (const line of lines) {
    const dm = line.match(/info depth (\d+)/);
    if (!dm || Number(dm[1]) < targetDepth) continue;
    const pvM = line.match(/multipv (\d+)/);
    const pvIdx = pvM ? Number(pvM[1]) : 1;
    const mate = line.match(/score mate (-?\d+)/);
    const cp = line.match(/score cp (-?\d+)/);
    let score;
    if (mate) score = { type: "mate", value: Number(mate[1]) };
    else if (cp) score = { type: "cp", cp: Number(cp[1]) };
    else continue;
    const pvTail = line.match(/\bpv\s+(.+)$/);
    const pv = pvTail ? pvTail[1].trim().split(/\s+/) : [];
    byPv.set(pvIdx, { multipv: pvIdx, score, pv });
  }
  const out = [];
  for (let i = 1; i <= multipv; i += 1) {
    if (byPv.has(i)) out.push(byPv.get(i));
  }
  return out;
}

export class StockfishPool {
  constructor(exePath, { threads = 4, hash = 256 } = {}) {
    this.proc = spawn(exePath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.pending = null;
    this.buf = "";
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk.toString();
      if (this.pending?.resolve && this.pending.done(this.buf)) {
        const resolve = this.pending.resolve;
        this.pending = null;
        resolve(this.buf);
      }
    });
    this.proc.stderr.on("data", () => {});
    this.proc.stdin.write(
      `uci\nsetoption name Threads value ${threads}\nsetoption name Hash value ${hash}\n`,
    );
    this.chain = this._await("isready", (b) => b.includes("readyok"));
  }

  _await(cmd, done) {
    return new Promise((resolve) => {
      this.buf = "";
      this.pending = { resolve, done };
      this.proc.stdin.write(`${cmd}\n`);
    });
  }

  async _go(fen, depth, { multipv = 1 } = {}) {
    if (multipv > 1) {
      this.chain = this.chain.then(() => {
        this.proc.stdin.write(`setoption name MultiPV value ${multipv}\n`);
        return this._await("isready", (b) => b.includes("readyok"));
      });
    }
    this.chain = this.chain.then(() => {
      this.proc.stdin.write(`position fen ${fen}\n`);
      return this._await(`go depth ${depth}`, (b) => b.includes("bestmove"));
    });
    const buf = await this.chain;
    if (multipv > 1) {
      this.chain = this.chain.then(() => {
        this.proc.stdin.write("setoption name MultiPV value 1\n");
        return this._await("isready", (b) => b.includes("readyok"));
      });
      await this.chain;
    }
    return buf;
  }

  async evalPosition(fen, depth) {
    const buf = await this._go(fen, depth);
    const sideToMove = fen.split(" ")[1] === "b" ? "black" : "white";
    const score = parseFinalDepthScore(buf, depth);
    return { score, sideToMove, buf };
  }

  async evalAfterUci(fen, uci, depth) {
    const chess = new Chess(fen);
    chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] || undefined,
    });
    return this.evalPosition(chess.fen(), depth);
  }

  async bestMove(fen, depth) {
    const buf = await this._go(fen, depth);
    return parseBestMove(buf);
  }

  async topMoves(fen, depth, multipv = 2) {
    const buf = await this._go(fen, depth, { multipv });
    return parseMultipvAtDepth(buf, depth, multipv);
  }

  quit() {
    try {
      this.proc.stdin.write("quit\n");
    } catch (_) {
      /* ignore */
    }
  }
}