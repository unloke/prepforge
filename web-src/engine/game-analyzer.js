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
// Upper bound on concurrent Stockfish providers. Each provider runs its own Web Worker
// with a single Stockfish search thread (the provider never sends `setoption Threads`, so
// the engine stays at its default of one), so one worker ≈ one core. We still cap the pool
// to keep WASM memory bounded (each provider loads its own engine image).
const MAX_CONCURRENCY = 6;

// Pick a worker count when the caller didn't pin one: roughly one worker per core but
// reserve a core for the UI/main thread, then clamp to [1, MAX_CONCURRENCY]. Exported so
// the heuristic itself is unit-testable without spinning up real engines.
export function resolveConcurrency(requested) {
  if (Number.isFinite(requested) && requested >= 1) return Math.floor(requested);
  const hw =
    (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(MAX_CONCURRENCY, hw - 1));
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
 * A pool of `concurrency` workers pulls from one shared dynamic queue of DISTINCT
 * FENs; each worker owns one Stockfish provider. The queue is deduplicated up front,
 * so a FEN that appears at several indices (a caller that didn't dedup, or a game with
 * a repeated position) is searched exactly ONCE and its eval is fanned out to every
 * index that shares it — no two workers ever burn redundant compute on the same
 * position. The returned Map's insertion order matches the FENs' first appearance in
 * `positions`, identical to the previous last-wins behaviour for distinct input.
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

  // Deduplicate the work: build the list of distinct FENs (in first-appearance order)
  // plus, for each, how many input indices it covers. Progress is still reported on the
  // ORIGINAL position scale (what the UI's toast shows), so a unique FEN that covers N
  // indices advances the bar by N when it finishes.
  const uniqueFens = [];
  const coverage = new Map(); // fen -> count of indices sharing it
  for (const fen of positions) {
    const seen = coverage.get(fen);
    if (seen === undefined) {
      coverage.set(fen, 1);
      uniqueFens.push(fen);
    } else {
      coverage.set(fen, seen + 1);
    }
  }

  const evalByFen = new Map();
  // Shared dynamic queue over distinct FENs: workers hand out by index, not by chunk.
  let nextUnique = 0;
  let completed = 0;
  // Set by any worker that throws (real error or cancel) so its siblings stop pulling
  // new work instead of running the rest of the queue to completion.
  let aborted = false;

  const externalCancel = () =>
    typeof shouldCancel === "function" ? shouldCancel() : false;
  const cancelled = () => aborted || externalCancel();

  function takeNextFen() {
    if (cancelled() || nextUnique >= uniqueFens.length) return null;
    const fen = uniqueFens[nextUnique];
    nextUnique += 1;
    return fen;
  }

  // Advance progress by every original index this FEN covered, so the bar reaches the
  // full position total even though the engine ran fewer distinct searches.
  function reportProgress(fen) {
    completed += coverage.get(fen) || 1;
    if (typeof onProgress === "function") onProgress(completed, total);
  }

  async function workerLoop() {
    const provider = createProvider({ maxDepth: targetDepth });
    let opened = false;
    try {
      while (!cancelled()) {
        const fen = takeNextFen();
        if (fen == null) break;

        // Game-over positions (e.g. the final fen_after of a checkmating PGN)
        // produce no engine info — Stockfish just returns `bestmove (none)`. Skip
        // the engine entirely so we don't block on the per-position timeout.
        if (isTerminalPosition(fen)) {
          evalByFen.set(fen, terminalEval(fen));
          reportProgress(fen);
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

        evalByFen.set(fen, await waitForEval(provider, fen, targetDepth, cancelled));
        reportProgress(fen);
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

  const workerCount = Math.max(
    1,
    Math.min(resolveConcurrency(concurrency), uniqueFens.length),
  );
  const settled = await Promise.allSettled(
    Array.from({ length: workerCount }, () => workerLoop()),
  );

  const rejection = settled.find((s) => s.status === "rejected");
  if (rejection) throw rejection.reason;
  // External cancellation makes workers exit their loop cleanly (no throw), so
  // re-check here to preserve the original "cancel → throw" contract.
  if (externalCancel()) throw new AnalysisCancelled();

  // Fan out: one entry per distinct FEN, in first-appearance order.
  const results = new Map();
  for (const fen of uniqueFens) {
    if (evalByFen.has(fen)) results.set(fen, evalByFen.get(fen));
  }
  return results;
}

export { AnalysisCancelled };
