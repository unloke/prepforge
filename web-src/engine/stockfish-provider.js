import { Chess } from "chess.js";

// Browser Stockfish (nmrugg stockfish.js, lite multi-threaded SF18) running in
// a Web Worker over UCI. Implements the EngineProvider interface
// (open/update/snapshot/close -> snapshot), so EngineWidget is unchanged.
// Needs cross-origin isolation (COOP/COEP) for threads.
//
// `stockfish-18-lite` is the same Stockfish 18 search code with an embedded
// SMALL net: weaker than the full ~113 MB net, but appropriate for the browser
// widget. All chess compute runs locally — there is NO server fallback (hard
// product rule: the server must never run engine compute in the public flow).

const ENGINE_URL = "/static/engine/stockfish-18-lite.js";
const DEFAULT_MAX_DEPTH = 18;
// MultiPV ceiling. The engine widget only ever shows a few lines, but Build Generate
// (Phase 3c) needs `branchLimit + manualPreparedCount` candidates so it can skip preserved
// manual moves and still find a new branch — so the cap is configurable per provider.
const DEFAULT_MAX_MULTIPV = 5;
const READY_TIMEOUT_MS = 15000;
// Safety net for the stop-drain (see startSearch): how long to wait for a stopped search's
// concluding `bestmove` before proceeding anyway. Stockfish answers `stop` with a `bestmove`
// almost immediately, so this only fires for a wedged engine — without it a missing bestmove
// would hang the whole analysis pool (the caller awaits the drain, never reaching the
// per-position timeout in game-analyzer).
const DRAIN_TIMEOUT_MS = 15000;

function uid() {
  return "sfw-" + Math.random().toString(36).slice(2, 10);
}

/** Convert a UCI pv (array of long-algebraic moves) to SAN from `fen`. */
function uciToSan(fen, uciMoves) {
  const san = [];
  try {
    const game = new Chess(fen);
    for (const uci of uciMoves) {
      const move = game.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      if (!move) break;
      san.push(move.san);
    }
  } catch (_) {
    // Illegal/garbled pv tail — return whatever converted cleanly.
  }
  return san;
}

export function createStockfishWasmProvider({
  maxDepth = DEFAULT_MAX_DEPTH,
  maxMultipv = DEFAULT_MAX_MULTIPV,
  // Injectable for tests; the live flow always constructs the real Web Worker. A factory
  // (not a worker instance) so the provider still owns the worker lifecycle and can rebuild
  // it after a fatal error exactly as before.
  createWorker = () => new Worker(ENGINE_URL),
} = {}) {
  let worker = null;
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let readyTimer = null;
  let newGameSent = false;
  // Stop-drain state. When we switch FENs while a search is still in flight we must STOP the
  // old search and wait for its concluding `bestmove` before starting the new one, so the old
  // search's trailing `info`/`bestmove` can't pollute the new FEN's state (the bug: switching
  // FENs reset state synchronously, then late UCI lines from the search we were abandoning were
  // parsed as the NEW position's, and the old `bestmove` flipped the new search to done).
  let draining = false;
  let drainResolve = null;
  let drainTimer = null;
  // Serialize open/update so only ONE search-switch is ever in flight. The drain state above is
  // a single set of globals; two overlapping update() calls (e.g. the Engine widget's
  // onBoardChanged + a multipv change) would otherwise have the second drain overwrite the
  // first's resolver, orphaning the first caller's promise forever. Chaining every op behind the
  // previous one closes that race (and also prevents two startSearch posting `go` concurrently).
  let opChain = Promise.resolve();
  // Bumped by close(). Each open()/update() captures this at CALL time (before queueing behind
  // opChain) and re-checks it after every await: an op whose captured generation no longer matches
  // was created before a close() and must NOT proceed. This is what stops both (a) the op resuming
  // from a drain that close() released and (b) an op already QUEUED behind that drain from
  // recreating a worker and launching a search on a torn-down provider (resurrecting a hidden
  // worker / making the widget re-poll a closed panel). A fresh open()/update() issued AFTER close
  // captures the new generation and revives cleanly — the widget reuses the same provider instance
  // on reopen (app.js _ensureEngine keeps `this.engine` after close). Note we must NOT reset this
  // inside the serialized task body, or a queued pre-close op would wrongly "revive" the provider.
  let generation = 0;

  function failReady(message) {
    state.error = message;
    state.running = false;
    // A worker error / startup timeout is a HARD failure of this worker. Bump the generation so an
    // op awaiting (or queued behind) the drain we release below bails on its post-await generation
    // check instead of silently recreating a worker and masking the error — that op then resolves
    // with the error snapshot, which the caller (waitForEval / the widget) surfaces. Also reset
    // newGameSent so a later rebuild re-sends `ucinewgame` to the fresh worker.
    generation += 1;
    newGameSent = false;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    // Release any in-flight drain so the awaiting startSearch() unblocks; the caller's
    // waitForEval then sees snapshot.error and throws rather than hanging on a dead worker.
    finishDrain();
    if (worker) {
      try {
        worker.terminate();
      } catch (_) {
        /* ignore */
      }
      worker = null;
    }
    if (readyReject) {
      const reject = readyReject;
      readyReject = null;
      readyResolve = null;
      reject(new Error(message));
    }
  }

  const state = {
    session_id: null,
    engine: "stockfish (browser)",
    fen: null,
    side_to_move: "white",
    multipv: 1,
    max_depth: maxDepth,
    current_depth: 0,
    pvs: [],
    running: false,
    error: null,
  };

  // End the current drain: the stopped search has concluded (its `bestmove` arrived) or the
  // drain timed out / the worker died. Idempotent — safe to call when not draining.
  function finishDrain() {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    draining = false;
    state.running = false;
    if (drainResolve) {
      const resolve = drainResolve;
      drainResolve = null;
      resolve();
    }
  }

  // Drop the current worker WITHOUT a permanent failure, so the next startSearch re-inits a
  // fresh one via ensureWorker. Used when a drain times out: a wedged engine's late `info`/
  // `bestmove` can't be told apart from the new search's on the same worker, so the only way to
  // keep #6's no-pollution guarantee is to discard the worker entirely (terminate kills its
  // output for good) and start clean.
  function hardResetWorker() {
    if (worker) {
      try {
        worker.terminate();
      } catch (_) {
        /* ignore */
      }
      worker = null;
    }
    readyPromise = null;
    readyResolve = null;
    readyReject = null;
    newGameSent = false;
  }

  function handleLine(line) {
    if (line === "readyok") {
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      readyReject = null;
      if (readyResolve) {
        const resolve = readyResolve;
        readyResolve = null;
        resolve();
      }
      return;
    }
    if (line.startsWith("bestmove")) {
      // While draining, THIS is the concluding bestmove of the search we asked to stop — it
      // ends the drain and must NOT be attributed to the (not-yet-started) new search.
      if (draining) {
        finishDrain();
        return;
      }
      state.running = false;
      return;
    }
    if (line.startsWith("info ") && line.includes(" pv ")) {
      // `info` emitted by the search we're stopping is stale — dropping it keeps it out of the
      // new FEN's pvs/current_depth.
      if (draining) return;
      parseInfo(line);
    }
  }

  function parseInfo(line) {
    const parts = line.split(/\s+/);
    let depth = null;
    let multipv = 1;
    let scoreCp = null;
    let mateIn = null;
    let pv = [];
    for (let i = 1; i < parts.length; i += 1) {
      const tok = parts[i];
      if (tok === "depth") depth = Number(parts[i + 1]);
      else if (tok === "multipv") multipv = Number(parts[i + 1]);
      else if (tok === "score") {
        if (parts[i + 1] === "cp") scoreCp = Number(parts[i + 2]);
        else if (parts[i + 1] === "mate") mateIn = Number(parts[i + 2]);
      } else if (tok === "pv") {
        pv = parts.slice(i + 1).filter(Boolean);
        break;
      }
    }
    if (!pv.length) return;

    // UCI reports from the side-to-move's POV; the rest of the app expects
    // White's POV (matches the server's EngineSession), so flip for Black.
    if (state.side_to_move === "black") {
      if (scoreCp !== null) scoreCp = -scoreCp;
      if (mateIn !== null) mateIn = -mateIn;
    }

    if (depth !== null && depth > state.current_depth) state.current_depth = depth;

    const rank = Math.max(1, multipv);
    while (state.pvs.length < rank) {
      state.pvs.push({
        rank: state.pvs.length + 1,
        depth: 0,
        score_cp: null,
        mate_in: null,
        pv_uci: [],
        pv_san: [],
      });
    }
    state.pvs[rank - 1] = {
      rank,
      depth: depth || 0,
      score_cp: scoreCp,
      mate_in: mateIn,
      pv_uci: pv,
      pv_san: uciToSan(state.fen, pv),
    };
  }

  function ensureWorker() {
    if (worker) return readyPromise;
    try {
      worker = createWorker();
    } catch (err) {
      readyPromise = Promise.reject(
        new Error("Browser engine could not start: " + (err && err.message)),
      );
      return readyPromise;
    }
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      readyTimer = setTimeout(() => {
        readyTimer = null;
        failReady(
          "Browser engine timed out starting up. Analysis must run locally; " +
            "server fallback is disabled.",
        );
      }, READY_TIMEOUT_MS);
    });
    worker.onmessage = (event) => {
      const line =
        typeof event.data === "string" ? event.data : event.data && event.data.data;
      if (typeof line === "string") handleLine(line);
    };
    worker.onerror = (event) => {
      failReady((event && event.message) || "engine worker failed to load");
    };
    worker.postMessage("uci");
    worker.postMessage("isready");
    return readyPromise;
  }

  // Run `task` only after every previously-queued open/update has fully settled, so search
  // switches never overlap. Each op runs regardless of whether the prior one resolved or threw;
  // the returned promise carries this op's own outcome, while opChain is kept rejection-safe so
  // one failure can't wedge the queue.
  function serialize(task) {
    const result = opChain.then(task, task);
    opChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // Stop the in-flight search and resolve once its concluding `bestmove` arrives (or the
  // safety timeout fires). Only called when state.running is true. Trailing `info` from the
  // stopped search is dropped while draining; see handleLine.
  function drainCurrentSearch() {
    return new Promise((resolve) => {
      draining = true;
      drainResolve = resolve;
      drainTimer = setTimeout(() => {
        // The drain may have already ended via the concluding `bestmove` (or a close()) in the
        // same tick this timer fired: clearTimeout can't cancel an already-queued callback, so
        // bail if the drain is no longer live — otherwise we'd tear down a now-healthy worker
        // (possibly mid-relaunch).
        if (!drainResolve) return;
        // The old search didn't conclude in time (wedged engine). We can't safely keep using
        // this worker — its late output would pollute the next search and is indistinguishable
        // from it — so tear the worker down; startSearch re-inits a fresh one before launching.
        drainTimer = null;
        draining = false;
        state.running = false;
        hardResetWorker();
        if (drainResolve) {
          const r = drainResolve;
          drainResolve = null;
          r();
        }
      }, DRAIN_TIMEOUT_MS);
      worker.postMessage("stop");
    });
  }

  // Start a fresh search for `fen`. If a previous search is still in flight, drain it first so
  // its trailing UCI output can't pollute this one — only THEN reset state and launch, so the
  // window where stale `info`/`bestmove` could land on the new FEN is closed.
  async function startSearch(fen, multipv, gen) {
    if (state.running) {
      await drainCurrentSearch();
    }
    // close() may have fired while we were draining (it resolves the drain to unblock us). A
    // generation bump means this op is now stale — do not recreate a worker or launch on a
    // torn-down provider (that resurrects a hidden worker and makes the widget re-poll a closed
    // panel).
    if (gen !== generation) {
      state.running = false;
      return;
    }
    // A timed-out drain may have torn down the wedged worker; bring a fresh one up first.
    if (!worker) {
      await ensureWorker();
      // Re-check: close() can also land during the ready handshake above.
      if (gen !== generation) {
        hardResetWorker();
        state.running = false;
        return;
      }
    }
    state.fen = fen;
    state.side_to_move = fen.split(" ")[1] === "b" ? "black" : "white";
    state.multipv = Math.max(1, Math.min(maxMultipv, multipv || 1));
    state.current_depth = 0;
    state.pvs = [];
    state.running = true;
    state.error = null;
    if (!newGameSent) {
      worker.postMessage("ucinewgame");
      newGameSent = true;
    }
    worker.postMessage("setoption name MultiPV value " + state.multipv);
    worker.postMessage("position fen " + fen);
    worker.postMessage("go depth " + state.max_depth);
  }

  return {
    kind: "wasm",
    // open/update both run through serialize() so a search-switch never overlaps another (see
    // opChain). update() inlines the no-worker fallback rather than delegating to open(), since
    // re-entering serialize() from within a serialized op would deadlock on opChain.
    open({ fen, multipv }) {
      const gen = generation; // capture at call time, before this op queues behind opChain
      return serialize(async () => {
        if (gen !== generation) return this.snapshot(); // a close() landed after this call
        await ensureWorker();
        if (gen !== generation) return this.snapshot();
        state.session_id = state.session_id || uid();
        await startSearch(fen, multipv, gen);
        return this.snapshot();
      });
    },
    update({ fen, multipv }) {
      const gen = generation; // capture at call time, before this op queues behind opChain
      return serialize(async () => {
        if (gen !== generation) return this.snapshot(); // a close() landed after this call
        if (!worker) {
          await ensureWorker();
          state.session_id = state.session_id || uid();
        } else {
          await readyPromise;
        }
        if (gen !== generation) return this.snapshot();
        await startSearch(fen, multipv, gen);
        return this.snapshot();
      });
    },
    snapshot() {
      return { ...state, pvs: state.pvs.map((pv) => ({ ...pv })) };
    },
    close() {
      // Bump generation BEFORE releasing the drain: the awaited startSearch resumes synchronously
      // off finishDrain()'s resolve, and must see the new generation so it bails instead of
      // recreating a worker. Any op already queued behind the drain captured the old generation,
      // so it bails too.
      generation += 1;
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      // Release any pending drain so a close() mid-switch can't leave startSearch awaiting
      // forever (also clears its timer).
      finishDrain();
      // Settle a pending ready handshake. If we close while a worker is still starting up, the op
      // awaiting ensureWorker()'s readyPromise would otherwise hang forever — and because every op
      // chains through opChain, that wedges ALL future open()/update() on this (reused) instance.
      // Reject it so the awaiting op settles and the queue stays usable.
      if (readyReject) {
        const reject = readyReject;
        readyReject = null;
        readyResolve = null;
        reject(new Error("Browser engine closed"));
      }
      if (worker) {
        try {
          worker.postMessage("quit");
        } catch (_) {
          /* ignore */
        }
        worker.terminate();
        worker = null;
      }
      readyPromise = null;
      readyResolve = null;
      readyReject = null;
      newGameSent = false;
      state.session_id = null;
      state.running = false;
      return Promise.resolve();
    },
  };
}

/**
 * Provider stub used when the browser engine cannot run. It never touches the
 * server — per the hard product rule, engine compute is browser-only and there
 * is NO server fallback. open/update reject with a clear, actionable message;
 * snapshot surfaces the same error so the widget renders it.
 */
function createUnavailableProvider(message) {
  return {
    kind: "unavailable",
    open() {
      return Promise.reject(new Error(message));
    },
    update() {
      return Promise.reject(new Error(message));
    },
    snapshot() {
      return { session_id: null, running: false, pvs: [], error: message };
    },
    close() {
      return Promise.resolve();
    },
  };
}

/**
 * The engine provider for the public flow: browser Stockfish only. If the page
 * is not cross-origin isolated, or the engine cannot be constructed, return a
 * provider that surfaces an actionable error — it NEVER falls back to the
 * server (hard product rule: no server-side engine compute in the public flow).
 */
export function createEngineProvider(options = {}) {
  if (!self.crossOriginIsolated) {
    return createUnavailableProvider(
      "Browser engine unavailable: this page is not cross-origin isolated " +
        "(COOP/COEP required). Analysis must run locally in a supported browser; " +
        "server fallback is disabled.",
    );
  }
  try {
    return createStockfishWasmProvider(options);
  } catch (_) {
    return createUnavailableProvider(
      "Browser engine unavailable. Analysis must run locally; server fallback " +
        "is disabled.",
    );
  }
}

/** True when the browser can run the local engine (cross-origin isolated). */
export function isBrowserEngineAvailable() {
  return Boolean(self.crossOriginIsolated);
}
