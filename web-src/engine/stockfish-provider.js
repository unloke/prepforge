import { Chess } from "chess.js";
import { createServerEngineProvider } from "./provider.js";

// Browser Stockfish (nmrugg stockfish.js, lite multi-threaded SF18) running in
// a Web Worker over UCI. Implements the same EngineProvider interface as the
// server provider (open/update/snapshot/close -> snapshot), so EngineWidget is
// unchanged. Needs cross-origin isolation (COOP/COEP) for threads.

const ENGINE_URL = "/static/engine/stockfish-18-lite.js";
const DEFAULT_MAX_DEPTH = 18;

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

export function createStockfishWasmProvider({ maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  let worker = null;
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let newGameSent = false;

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
      if (readyResolve) {
        readyResolve();
        readyResolve = null;
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
    worker = new Worker(ENGINE_URL);
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    worker.onmessage = (event) => {
      const line =
        typeof event.data === "string" ? event.data : event.data && event.data.data;
      if (typeof line === "string") handleLine(line);
    };
    worker.onerror = (event) => {
      const message = (event && event.message) || "engine worker failed to load";
      state.error = message;
      state.running = false;
      if (readyReject) {
        readyReject(new Error(message));
        readyReject = null;
      }
    };
    worker.postMessage("uci");
    worker.postMessage("isready");
    return readyPromise;
  }

  function go(fen, multipv) {
    state.fen = fen;
    state.side_to_move = fen.split(" ")[1] === "b" ? "black" : "white";
    state.multipv = Math.max(1, Math.min(5, multipv || 1));
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
 * Pick the best available engine provider: browser Stockfish when the page is
 * cross-origin isolated (threads available), otherwise the server. The browser
 * provider transparently falls back to the server if its worker fails at
 * runtime (e.g. asset missing), so the widget always has a working engine.
 */
export function createEngineProvider({ api, postJson }) {
  const server = createServerEngineProvider({ api, postJson });
  if (!self.crossOriginIsolated) return server;

  let wasm;
  try {
    wasm = createStockfishWasmProvider();
  } catch (_) {
    return server;
  }

  let active = wasm;
  let fellBack = false;

  async function call(method, arg) {
    try {
      return await active[method](arg);
    } catch (err) {
      if (!fellBack && active === wasm) {
        fellBack = true;
        active = server;
        try {
          await wasm.close();
        } catch (_) {
          /* ignore */
        }
        return active[method](arg);
      }
      throw err;
    }
  }

  return {
    get kind() {
      return active.kind;
    },
    open: (arg) => call("open", arg),
    update: (arg) => call("update", arg),
    snapshot: () => active.snapshot(),
    close: () => active.close(),
  };
}
