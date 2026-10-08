import { Chess } from "chess.js";
import { ANALYSIS_MAX_NODES, createEngineProvider } from "./stockfish-provider.js";
import { waitForEngineSearch } from "./engine-search-wait.js";
import { stockfishBudget } from "./compute-budget.js";

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

// Hard ceiling per position so a stuck search can't hang the whole run.
const PER_POSITION_TIMEOUT_MS = 30000;
// Node budget per position (see ANALYSIS_MAX_NODES), applied with the depth limit.
const DEFAULT_MAX_NODES = ANALYSIS_MAX_NODES;
// Upper bound on concurrent Stockfish providers. Each provider is a threaded-lite engine
// instance that reserves its own 128 MB shared WASM heap plus a pthread worker, and the
// Maia pass and the live board engine run beside it, so the pool stays small.
const MAX_CONCURRENCY = 4;

// Warm browser engines a finished pass leaves behind for the next one. Starting a Stockfish
// worker (WASM + network load) costs ~250 ms, and a game analysis runs a few small batches
// right after the main pass (the Maia trap and gap reads): they pick these up instead of
// paying that again. Only the real browser engine is pooled; an idle one closes on its own.
const POOL_IDLE_MS = 8000;
const idleEngines = []; // { provider, maxNodes, timer }

function takeIdleEngine(maxNodes) {
  const k = idleEngines.findIndex((e) => e.maxNodes === maxNodes);
  if (k < 0) return null;
  const [entry] = idleEngines.splice(k, 1);
  clearTimeout(entry.timer);
  entry.unregisterIdle?.();
  return entry.provider;
}

function parkIdleEngine(provider, maxNodes) {
  if (idleEngines.length >= MAX_CONCURRENCY) return false;
  const entry = { provider, maxNodes, timer: null, unregisterIdle: null };
  const reclaim = () => {
    const k = idleEngines.indexOf(entry);
    if (k < 0) return;
    idleEngines.splice(k, 1);
    clearTimeout(entry.timer);
    entry.unregisterIdle?.();
    Promise.resolve(provider.close()).catch(() => {});
  };
  entry.timer = setTimeout(reclaim, POOL_IDLE_MS);
  idleEngines.push(entry);
  entry.unregisterIdle = stockfishBudget.registerIdle(reclaim);
  return true;
}

// Pick a worker count when the caller didn't pin one: half the logical cores (leaving room
// for the UI, Maia and the live engine), clamped to [1, MAX_CONCURRENCY]. Exported so the
// heuristic itself is unit-testable without spinning up real engines.
export function resolveConcurrency(requested) {
  if (Number.isFinite(requested) && requested >= 1) return Math.min(MAX_CONCURRENCY, Math.floor(requested));
  const hw =
    (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(hw / 2)));
}

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
        depth: 0,
        nodes: 0,
      };
    }
  } catch (_) {
    // Unparseable FEN — fall through to a neutral score.
  }
  return { score_cp: 0, mate_in: null, best_move_uci: null, pv: [], depth: 0, nodes: 0 };
}

// Extract a White-POV eval from the provider's snapshot, or a terminal fallback.
// The result carries the ACTUAL depth the search reached — a timeout that
// accepted a shallow result must never be stored/marked as the requested depth.
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
    pv_san: top.pv_san ? top.pv_san.slice() : [],
    depth: (snapshot && snapshot.current_depth) || top.depth || 0,
    nodes: (snapshot && snapshot.nodes) ?? null,
    iterations: snapshot.iterations,
    // The second line of a MultiPV >= 2 search (the best OTHER move), when there is one.
    second: lineAt(snapshot, 1),
    third: lineAt(snapshot, 2),
  };
}

function lineAt(snapshot, index) {
  const line = snapshot && snapshot.pvs && snapshot.pvs[index];
  if (!line || !line.pv_uci || !line.pv_uci.length || (line.score_cp == null && line.mate_in == null)) return null;
  return { move_uci: line.pv_uci[0], score_cp: line.score_cp ?? null, mate_in: line.mate_in ?? null };
}

// Block until `provider` has a usable eval for `fen` at `targetDepth`, then
// return its White-POV eval. The search is done when it is no longer running AND
// has produced at least one depth of info; the depth guard rejects the spurious
// `bestmove` the engine emits in response to the `stop` that precedes each new
// search. Throws AnalysisCancelled if `cancelled()` flips while we wait.
async function waitForEval(provider, fen, targetDepth, cancelled) {
  const snapshot = await waitForEngineSearch(provider, {
    targetDepth,
    cancelled,
    timeoutMs: PER_POSITION_TIMEOUT_MS,
    acceptShallowOnTimeout: true,
    fen,
    onCancel: () => new AnalysisCancelled(),
  });
  return evalFromSnapshot(fen, snapshot);
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
 *   maxNodes?: number,
 *   createProvider?: (opts: { maxDepth: number, maxNodes: number }) => object,
 *   reuse?: (fen: string) => object | null,
 *   onResult?: (fen: string, evalResult: object) => void,
 * }} opts
 */
export async function analyzeGamePositions({
  positions,
  depth,
  multipv = 1,
  onProgress,
  shouldCancel,
  concurrency,
  maxNodes = DEFAULT_MAX_NODES,
  // Injectable for tests; the live flow always uses the browser Stockfish provider.
  createProvider = createEngineProvider,
  // A finished eval the caller already holds for a FEN at this depth (or null): it is
  // used as-is instead of searching again.
  reuse = null,
  // Called once per distinct FEN as soon as its eval is known (reused or searched), so
  // a consumer can show results while the rest of the game is still running.
  onResult = null,
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
  let completed = 0;
  // Advance progress by every original index this FEN covered, so the bar reaches the
  // full position total even though the engine ran fewer distinct searches.
  function reportProgress(fen) {
    completed += coverage.get(fen) || 1;
    if (typeof onProgress === "function") onProgress(completed, total);
  }
  function record(fen, ev) {
    evalByFen.set(fen, ev);
    if (typeof onResult === "function") {
      try { onResult(fen, ev); } catch (_) { /* a consumer's error never stops the pass */ }
    }
    reportProgress(fen);
  }
  // Positions the caller already has never reach a worker.
  const pending = [];
  for (const fen of uniqueFens) {
    const known = typeof reuse === "function" ? reuse(fen) : null;
    if (known) record(fen, known);
    else pending.push(fen);
  }
  // Shared dynamic queue over distinct FENs: workers hand out by index, not by chunk.
  let nextUnique = 0;
  // Set by any worker that throws (real error or cancel) so its siblings stop pulling
  // new work instead of running the rest of the queue to completion.
  let aborted = false;

  const externalCancel = () =>
    typeof shouldCancel === "function" ? shouldCancel() : false;
  const cancelled = () => aborted || externalCancel();

  function takeNextFen() {
    if (cancelled() || nextUnique >= pending.length) return null;
    const fen = pending[nextUnique];
    nextUnique += 1;
    return fen;
  }

  async function workerLoop() {
    const pooled = createProvider === createEngineProvider;
    const warm = pooled ? takeIdleEngine(maxNodes) : null;
    const provider = warm || createProvider({ maxDepth: targetDepth, maxNodes });
    let opened = !!warm;
    let clean = false;
    // Allocation/handshake waits happen before search polling. Keep cancellation
    // and the deadline active there too, so queued jobs cannot hang indefinitely.
    async function startRead(read) {
      let timer;
      try {
        return await Promise.race([read(), new Promise((_, reject) => {
          const started = Date.now();
          timer = setInterval(() => {
            const stopped = cancelled();
            if (!stopped && Date.now() - started < PER_POSITION_TIMEOUT_MS) return;
            reject(stopped ? new AnalysisCancelled() : new Error("Browser engine startup timed out"));
            Promise.resolve(provider.close()).catch(() => {});
          }, 100);
        })]);
      } finally { clearInterval(timer); }
    }
    try {
      while (!cancelled()) {
        const fen = takeNextFen();
        if (fen == null) break;

        // Game-over positions (e.g. the final fen_after of a checkmating PGN)
        // produce no engine info — Stockfish just returns `bestmove (none)`. Skip
        // the engine entirely so we don't block on the per-position timeout.
        if (isTerminalPosition(fen)) {
          record(fen, terminalEval(fen));
          continue;
        }

        // Reuse this worker's session across its positions: open the first,
        // update the rest.
        if (!opened) {
          await startRead(() => provider.open({ fen, multipv, depth: targetDepth }));
          opened = true;
        } else {
          await startRead(() => provider.update({ fen, multipv, depth: targetDepth }));
        }

        record(fen, await waitForEval(provider, fen, targetDepth, cancelled));
      }
      clean = !cancelled();
    } catch (err) {
      // Stop the other workers, then surface the failure to the caller.
      aborted = true;
      throw err;
    } finally {
      // A worker that finished its share cleanly stays warm for the next batch; one that
      // failed or was stopped mid-search is torn down.
      if (!(pooled && clean && opened && parkIdleEngine(provider, maxNodes))) {
        try {
          await provider.close();
        } catch (_) {
          /* ignore teardown errors */
        }
      }
    }
  }

  const workerCount = Math.max(
    1,
    Math.min(resolveConcurrency(concurrency), pending.length),
  );
  const settled = await Promise.allSettled(
    pending.length ? Array.from({ length: workerCount }, () => workerLoop()) : [],
  );

  const rejection = settled.find((s) => s.status === "rejected");
  if (rejection) {
    const err = rejection.reason;
    // Budget-expiry cancellation (AnalysisCancelled from workers) should include partial
    // results so the caller can use what was computed before time ran out.
    if (err instanceof AnalysisCancelled) {
      const partialResults = new Map();
      for (const fen of uniqueFens) {
        if (evalByFen.has(fen)) partialResults.set(fen, evalByFen.get(fen));
      }
      err.partialResults = partialResults;
    }
    throw err;
  }
  // External cancellation makes workers exit their loop cleanly (no throw), so
  // re-check here to preserve the original "cancel → throw" contract.
  if (externalCancel()) {
    const partialResults = new Map();
    for (const fen of uniqueFens) {
      if (evalByFen.has(fen)) partialResults.set(fen, evalByFen.get(fen));
    }
    const err = new AnalysisCancelled();
    err.partialResults = partialResults;
    throw err;
  }

  // Fan out: one entry per distinct FEN, in first-appearance order.
  const results = new Map();
  for (const fen of uniqueFens) {
    if (evalByFen.has(fen)) results.set(fen, evalByFen.get(fen));
  }
  return results;
}

export { AnalysisCancelled };
