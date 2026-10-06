// Browser Stockfish for the Scout path guard: one provider, sequential reads, a new game
// per line so the hash carries back along it. Reads are White-POV with node counts.
import { Chess } from "chess.js";
import { ANALYSIS_MAX_NODES, createEngineProvider } from "./engine/stockfish-provider.js";
import { waitForEngineSearch } from "./engine/engine-search-wait.js";

const READ_TIMEOUT_MS = 30000;

/** Game-over positions need no search: mate names the winner, any draw is level. */
export function terminalRead(fen) {
  let game;
  try { game = new Chess(fen); } catch { return null; }
  if (!game.isGameOver()) return null;
  const winner = game.isCheckmate() ? (game.turn() === "w" ? "black" : "white") : null;
  return { whiteCp: winner ? null : 0, whiteMate: null, winner, nodes: 0 };
}

export function createPathGuardEngine({
  createProvider = createEngineProvider,
  maxNodes = ANALYSIS_MAX_NODES,
  shouldCancel = () => false,
} = {}) {
  let provider = null;
  let opened = false;
  let fresh = true;
  return {
    async newLine() { fresh = true; },
    async read(fen, depth) {
      const terminal = terminalRead(fen);
      if (terminal) return terminal;
      provider ??= createProvider({ maxDepth: depth, maxNodes, priority: "background" });
      const request = { fen, multipv: 1, depth, newGame: fresh };
      if (opened) await provider.update(request);
      else { await provider.open(request); opened = true; }
      fresh = false;
      const snap = await waitForEngineSearch(provider, {
        targetDepth: depth,
        cancelled: shouldCancel,
        timeoutMs: READ_TIMEOUT_MS,
        acceptShallowOnTimeout: true,
        fen,
      });
      const top = snap.pvs?.[0];
      if (!top || (top.score_cp == null && top.mate_in == null)) throw new Error(`No evaluation for ${fen}`);
      return {
        whiteCp: top.score_cp ?? null,
        whiteMate: top.mate_in ?? null,
        winner: null,
        nodes: Number.isFinite(snap.nodes) ? snap.nodes : 0,
      };
    },
    async close() {
      if (provider) await Promise.resolve(provider.close()).catch(() => {});
      provider = null;
      opened = false;
    },
  };
}
