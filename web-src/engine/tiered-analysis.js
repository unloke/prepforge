// Two-tier whole-game analysis. Every position is searched SCREEN_DEPTH_DROP below the
// analysis depth (Settings → Stockfish depth); then the positions whose grade could hinge on
// the full depth are searched again at it. At the default depth 16 trained models pick them and
// send some to depth 20 instead, under a wider node cap (deepening-router.js). At other
// depths, where the models were not trained, both positions of any move whose win-chance loss
// at the screen depth is at least DEEP_LOSS_FLAG points, or that shows a mate, are deepened
// (research/analyze-speed/RESULTS.md, arm tiered1).
import { ROUTER_DEEP_MAX_NODES, ROUTER_DEPTH, routerDepths } from "./deepening-router.js";

export const SCREEN_DEPTH_DROP = 4;
export const SCREEN_MIN_DEPTH = 8;
export const DEEP_LOSS_FLAG = 1; // win% points, mover POV

// The screen depth for an analysis depth, or null when the depth is too low to tier.
export function screenDepthFor(depth) {
  const d = Math.floor(Number(depth) || 0);
  const screen = d - SCREEN_DEPTH_DROP;
  return screen >= SCREEN_MIN_DEPTH ? screen : null;
}

// White win% (0..100) of a White-POV eval: the server's sigmoid, cp clamped to ±1000.
function whiteWin(ev) {
  const mate = ev.mate_in;
  const cp = mate > 0 ? 1000 : mate < 0 ? -1000 : Math.max(-1000, Math.min(1000, Math.trunc(ev.score_cp ?? 0)));
  return 100 / (1 + Math.exp(-0.00368208 * cp));
}

// FENs that need the full-depth read: both positions of every move that loses at least
// DEEP_LOSS_FLAG points at the screen depth or has a mate score on either side.
export function deepFlags(moves, evals) {
  const flagged = new Set();
  for (const m of moves || []) {
    const before = evals.get(m.fen_before);
    const after = evals.get(m.fen_after);
    if (!before || !after) continue;
    const white = m.side !== "black";
    const loss = white ? whiteWin(before) - whiteWin(after) : whiteWin(after) - whiteWin(before);
    if (loss >= DEEP_LOSS_FLAG || before.mate_in != null || after.mate_in != null) {
      flagged.add(m.fen_before);
      flagged.add(m.fen_after);
    }
  }
  return flagged;
}

/**
 * Run the two passes through `analyze` (store.analyzeGame / analyzeGamePositions).
 *   onResult(fen, ev) — every read, screen and deep (the live graph).
 *   onFinal(fen, ev)  — once per position, with the read that will be saved (the Maia pass).
 *   onProgress(done, total, stage) — stage "screen" or "deep".
 * Returns { evals, screenDepth } (screenDepth null when the depth is too low to tier).
 */
export async function analyzeTiered({ analyze, positions, moves, depth, onResult, onFinal, onProgress, shouldCancel }) {
  const result = (fen, ev) => { if (typeof onResult === "function") onResult(fen, ev); };
  const final = (fen, ev) => { if (typeof onFinal === "function") onFinal(fen, ev); };
  const progress = (stage) => (done, total) => { if (typeof onProgress === "function") onProgress(done, total, stage); };
  const screenDepth = Array.isArray(moves) && moves.length ? screenDepthFor(depth) : null;
  if (!screenDepth) {
    const evals = await analyze({
      positions, depth, shouldCancel, onProgress: progress("deep"),
      onResult: (fen, ev) => { result(fen, ev); final(fen, ev); },
    });
    return { evals, screenDepth: null };
  }
  const routed = Number(depth) === ROUTER_DEPTH;
  const [screened, model] = await Promise.all([
    analyze({ positions, depth: screenDepth, shouldCancel, onProgress: progress("screen"), onResult: result }),
    routed ? import("./deepening-router-model.json").then((m) => m.default) : null,
  ]);
  const target = routed
    ? routerDepths(model, moves, screened)
    : new Map([...deepFlags(moves, screened)].map((fen) => [fen, depth]));
  // A read the store already had at the target depth (reused in the screen pass) needs no second search.
  const deep = positions.filter((fen) => target.has(fen) && !((screened.get(fen)?.depth ?? 0) >= target.get(fen)));
  const pending = new Set(deep);
  for (const [fen, ev] of screened) if (!pending.has(fen)) final(fen, ev);
  const evals = new Map(screened);
  // Deepest wave first, so the long searches don't trail at the end; progress counts both waves.
  const waves = [...new Set(deep.map((fen) => target.get(fen)))].sort((a, b) => b - a);
  let done = 0;
  for (const d of waves) {
    const fens = deep.filter((fen) => target.get(fen) === d);
    const deepEvals = await analyze({
      positions: fens, depth: d, shouldCancel, ...(d > depth ? { maxNodes: ROUTER_DEEP_MAX_NODES } : {}),
      onProgress: (n) => progress("deep")(done + n, deep.length),
      onResult: (fen, ev) => { result(fen, ev); final(fen, ev); },
    });
    done += fens.length;
    for (const [fen, ev] of deepEvals) evals.set(fen, ev);
  }
  return { evals, screenDepth };
}
