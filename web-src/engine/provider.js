/**
 * EngineProvider — the seam between the UI and whatever actually computes the
 * analysis. Phase 0 ships only `ServerEngineProvider` (wraps the existing
 * `/api/engine/*` endpoints). Phase 1 will add a `StockfishWasmProvider` that
 * runs Stockfish in a Web Worker and exposes this same interface, so the UI
 * (EngineWidget) does not change when the compute moves into the browser.
 *
 * Interface — all methods are async and resolve to a "snapshot":
 *   open({ fen, multipv })   -> snapshot   begin a session at a position
 *   update({ fen, multipv }) -> snapshot   re-target the session to a new FEN
 *   snapshot()               -> snapshot   latest progressive result (polled)
 *   close()                  -> void       tear the session down
 *
 * snapshot shape (mirrors the server's EngineSession.snapshot):
 *   {
 *     session_id, engine, fen, side_to_move, multipv, max_depth,
 *     current_depth,
 *     pvs: [{ rank, depth, score_cp, mate_in, pv_uci, pv_san }],
 *     running, error
 *   }
 */

/**
 * Server-backed provider: the analysis runs in the Python process and the UI
 * polls `snapshot()`. `api`/`postJson` are injected so this module stays
 * decoupled from the app's HTTP helpers (and so browser providers need none).
 *
 * @param {{ api: (path: string) => Promise<any>,
 *           postJson: (path: string, body: any) => Promise<any> }} deps
 */
export function createServerEngineProvider({ api, postJson }) {
  return {
    kind: "server",
    open({ fen, multipv }) {
      return postJson("/api/engine/open", { fen, multipv, engine: "stockfish" });
    },
    update({ fen, multipv }) {
      return postJson("/api/engine/update", { fen, multipv });
    },
    snapshot() {
      return api("/api/engine/snapshot");
    },
    close() {
      return postJson("/api/engine/close", {});
    },
  };
}
