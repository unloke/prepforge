import { Chess } from "chess.js";
import { createEngineProvider } from "./stockfish-provider.js";

// Whole-game analysis in the browser (Phase 2). Drives the browser Stockfish
// provider over every position of a game, each to a target depth, and returns
// one White-POV evaluation per FEN. The server then classifies + persists those
// evals (see /api/analyze/classify-save) — no server engine ever runs.
//
// Positions are evaluated by a pool of workers that pull from one shared dynamic
// queue (not static partitioning): each worker owns its own Stockfish provider
// and grabs the next un-taken position whenever it finishes one, so fast
// positions never wait on slow neighbours and the load self-balances. Results
// are stored by original index, so final ordering is deterministic regardless of
// which worker finished what. The UI is unchanged — progress still reports only a
// completed count and a total.

const POLL_MS = 90;
// Hard ceiling per position so a stuck search can't hang the whole run.
const PER_POSITION_TIMEOUT_MS = 30000;
// How many Stockfish providers to run concurrently. Each provider is itself
// multi-threaded, so we keep the pool modest to avoid oversubscribing cores.
const DEFAULT_CONCURRENCY = 4;

function resolveConcurrency(requested) {
  if (Number.isFinite(requested) && requested >= 1) return Math.floor(requested);
  const hw =
    (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(DEFAULT_CONCURRENCY, hw));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class AnalysisCancelled extends Error {
  constructor(message = "Analysis stopped") {
    super(message);
    this.cancelled = true;
  }
}

// True when the position has no legal continuation (checkmate, stalemate,
// insufficient material, threefold, 50-move) — the engine returns only
// `bestmove` with no depth info for these, so we must not wait on it.
export function isTerminalPosition(fen) {
  try {
    return new Chess(fen).isGameOver();
  } catch (_) {
    return false;
  }
}

// Decisive evaluation for a position with no engine line (game already over):
// checkmate-on-board saturates the score for the side that delivered mate;
// stalemate / dead position is a draw. Keeps every FEN classifiable.
export function terminalEval(fen) {
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

// Block until `provider` has a usable eval for `fen` at `targetDepth`, then
// return its White-POV eval. The search is done when it is no longer running AND
// has produced at least one depth of info; the depth guard rejects the spurious
// `bestmove` the engine emits in response to the `stop` that precedes each new
// search. Throws AnalysisCancelled if `cancelled()` flips while we wait.
async function waitForEval(provider, fen, targetDepth, cancelled) {
  const started = Date.now();
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
  return evalFromSnapshot(fen, provider.snapshot());
}

/**
 * Analyze every FEN in `positions` to `depth`, returning a Map<fen, evalResult>.
 *
 * A pool of `concurrency` workers pulls from one shared dynamic queue; each
 * worker owns one Stockfish provider. Results are collected by original index so
 * the returned Map's insertion order matches `positions` regardless of which
 * worker finished first (duplicate FENs resolve last-wins, as before).
 *
 * @param {{
 *   positions: string[],
 *   depth: number,
 *   multipv?: number,
 *   onProgress?: (done: number, total: number) => void,
 *   shouldCancel?: () => boolean,
 *   concurrency?: number,
 *   createProvider?: (opts: { maxDepth: number }) => object,
 * }} opts
 */
export async function analyzeGamePositions({
  positions,
  depth,
  multipv = 1,
  onProgress,
  shouldCancel,
  concurrency,
  // Injectable for tests; the live flow always uses the browser Stockfish provider.
  createProvider = createEngineProvider,
}) {
  const targetDepth = Math.max(1, Math.min(Number(depth) || 16, 60));
  const total = positions.length;
  if (!total) return new Map();

  const resultsByIndex = new Array(total);
  // Shared dynamic queue: workers hand out positions by index, not by chunk.
  let nextIndex = 0;
  let completed = 0;
  // Set by any worker that throws (real error or cancel) so its siblings stop
  // pulling new work instead of running the rest of the queue to completion.
  let aborted = false;

  const externalCancel = () =>
    typeof shouldCancel === "function" ? shouldCancel() : false;
  const cancelled = () => aborted || externalCancel();

  function takeNextPosition() {
    if (cancelled() || nextIndex >= total) return null;
    const index = nextIndex;
    nextIndex += 1;
    return { index, fen: positions[index] };
  }

  function reportProgress() {
    completed += 1;
    if (typeof onProgress === "function") onProgress(completed, total);
  }

  async function workerLoop() {
    const provider = createProvider({ maxDepth: targetDepth });
    let opened = false;
    try {
      while (!cancelled()) {
        const job = takeNextPosition();
        if (!job) break;
        const { index, fen } = job;

        // Game-over positions (e.g. the final fen_after of a checkmating PGN)
        // produce no engine info — Stockfish just returns `bestmove (none)`. Skip
        // the engine entirely so we don't block on the per-position timeout.
        if (isTerminalPosition(fen)) {
          resultsByIndex[index] = terminalEval(fen);
          reportProgress();
          continue;
        }

        // Reuse this worker's session across its positions: open the first,
        // update the rest.
        if (!opened) {
          await provider.open({ fen, multipv });
          opened = true;
        } else {
          await provider.update({ fen, multipv });
        }

        resultsByIndex[index] = await waitForEval(provider, fen, targetDepth, cancelled);
        reportProgress();
      }
    } catch (err) {
      // Stop the other workers, then surface the failure to the caller.
      aborted = true;
      throw err;
    } finally {
      try {
        await provider.close();
      } catch (_) {
        /* ignore teardown errors */
      }
    }
  }

  const workerCount = Math.max(1, Math.min(resolveConcurrency(concurrency), total));
  const settled = await Promise.allSettled(
    Array.from({ length: workerCount }, () => workerLoop()),
  );

  const rejection = settled.find((s) => s.status === "rejected");
  if (rejection) throw rejection.reason;
  // External cancellation makes workers exit their loop cleanly (no throw), so
  // re-check here to preserve the original "cancel → throw" contract.
  if (externalCancel()) throw new AnalysisCancelled();

  const results = new Map();
  for (let i = 0; i < total; i += 1) {
    if (resultsByIndex[i] !== undefined) results.set(positions[i], resultsByIndex[i]);
  }
  return results;
}

export { AnalysisCancelled };
