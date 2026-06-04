import { Chess } from "chess.js";
import { createEngineProvider } from "./stockfish-provider.js";

// Whole-game analysis in the browser (Phase 2). Drives the browser Stockfish
// provider over every position of a game, each to a target depth, and returns
// one White-POV evaluation per FEN. The server then classifies + persists those
// evals (see /api/analyze/classify-save) — no server engine ever runs.

const POLL_MS = 90;
// Hard ceiling per position so a stuck search can't hang the whole run.
const PER_POSITION_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class AnalysisCancelled extends Error {
  constructor(message = "Analysis stopped") {
    super(message);
    this.cancelled = true;
  }
}

// Decisive evaluation for a position with no engine line (game already over):
// checkmate-on-board saturates the score for the side that delivered mate;
// stalemate / dead position is a draw. Keeps every FEN classifiable.
function terminalEval(fen) {
  try {
    const game = new Chess(fen);
    if (game.isCheckmate()) {
      // The side to move is the one checkmated, so the OTHER side won.
      const whiteIsMated = game.turn() === "w";
      return {
        score_cp: whiteIsMated ? -100000 : 100000,
        mate_in: null,
        best_move_uci: null,
        pv: [],
      };
    }
  } catch (_) {
    // Unparseable FEN — fall through to a neutral score.
  }
  return { score_cp: 0, mate_in: null, best_move_uci: null, pv: [] };
}

// Extract a White-POV eval from the provider's snapshot, or a terminal fallback.
function evalFromSnapshot(fen, snapshot) {
  const top = snapshot && snapshot.pvs && snapshot.pvs[0];
  if (!top || (top.score_cp === null && top.mate_in === null)) {
    return terminalEval(fen);
  }
  return {
    score_cp: top.score_cp,
    mate_in: top.mate_in,
    best_move_uci: top.pv_uci && top.pv_uci.length ? top.pv_uci[0] : null,
    pv: top.pv_uci ? top.pv_uci.slice() : [],
  };
}

/**
 * Analyze every FEN in `positions` to `depth`, returning a Map<fen, evalResult>.
 *
 * @param {{
 *   positions: string[],
 *   depth: number,
 *   multipv?: number,
 *   onProgress?: (done: number, total: number) => void,
 *   shouldCancel?: () => boolean,
 * }} opts
 */
export async function analyzeGamePositions({
  positions,
  depth,
  multipv = 1,
  onProgress,
  shouldCancel,
}) {
  const targetDepth = Math.max(1, Math.min(Number(depth) || 16, 60));
  const provider = createEngineProvider({ maxDepth: targetDepth });
  const results = new Map();
  const total = positions.length;
  let opened = false;

  const cancelled = () => (typeof shouldCancel === "function" ? shouldCancel() : false);

  try {
    for (let i = 0; i < total; i += 1) {
      if (cancelled()) throw new AnalysisCancelled();
      const fen = positions[i];

      // Reuse one worker/session across positions: open the first, update the rest.
      if (!opened) {
        await provider.open({ fen, multipv });
        opened = true;
      } else {
        await provider.update({ fen, multipv });
      }

      const started = Date.now();
      // Wait for this position to finish: the search is done when it is no
      // longer running AND has produced at least one depth of info. The depth
      // guard rejects the spurious `bestmove` the engine emits in response to
      // the `stop` that precedes each new search.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const snapshot = provider.snapshot();
        if (snapshot.error) throw new Error(snapshot.error);
        const done = !snapshot.running && snapshot.current_depth > 0;
        const reached = snapshot.current_depth >= targetDepth && snapshot.pvs.length > 0;
        if (done || reached) break;
        if (Date.now() - started > PER_POSITION_TIMEOUT_MS) break;
        if (cancelled()) throw new AnalysisCancelled();
        await sleep(POLL_MS);
      }

      results.set(fen, evalFromSnapshot(fen, provider.snapshot()));
      if (typeof onProgress === "function") onProgress(i + 1, total);
    }
  } finally {
    try {
      await provider.close();
    } catch (_) {
      /* ignore teardown errors */
    }
  }

  return results;
}

export { AnalysisCancelled };
