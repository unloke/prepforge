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
} = {}) {
  let worker = null;
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let readyTimer = null;
  let newGameSent = false;

  function failReady(message) {
    state.error = message;
    state.running = false;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
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
      state.running = false;
      return;
    }
    if (line.startsWith("info ") && line.includes(" pv ")) {
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
      worker = new Worker(ENGINE_URL);
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

  function go(fen, multipv) {
    state.fen = fen;
    state.side_to_move = fen.split(" ")[1] === "b" ? "black" : "white";
    state.multipv = Math.max(1, Math.min(maxMultipv, multipv || 1));
    state.current_depth = 0;
    state.pvs = [];
    state.running = true;
    state.error = null;
    worker.postMessage("stop");
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
    async open({ fen, multipv }) {
      await ensureWorker();
      state.session_id = state.session_id || uid();
      go(fen, multipv);
      return this.snapshot();
    },
    async update({ fen, multipv }) {
      if (!worker) return this.open({ fen, multipv });
      await readyPromise;
      go(fen, multipv);
      return this.snapshot();
    },
    snapshot() {
      return { ...state, pvs: state.pvs.map((pv) => ({ ...pv })) };
    },
    close() {
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
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
