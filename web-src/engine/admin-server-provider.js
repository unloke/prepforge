/**
 * EngineProvider seam contract — the interface between the UI (EngineWidget)
 * and whatever actually computes the analysis. The PUBLIC flow uses the
 * browser-only provider in `stockfish-provider.js` (`createEngineProvider`).
 * This module holds the ADMIN-ONLY server-backed provider, kept apart so it
 * cannot be reached from the public flow by accident.
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
 * ADMIN-ONLY server-backed provider. The analysis runs in the Python process
 * and the UI polls `snapshot()`.
 *
 * ⚠️  Do NOT wire this into the public app. The hard product rule is that the
 * public/default flow never runs a server-side chess engine — Stockfish/Maia
 * compute happens in the browser (see `createEngineProvider`). The `/api/engine/*`
 * endpoints this calls are gated server-side behind PREPFORGE_SERVER_ENGINE_ENABLED
 * and return HTTP 403 by default, so even a mistaken wire-up fails closed rather
 * than quietly running the server engine. This provider exists only for a future
 * admin/server mode that deliberately opts in.
 *
 * `api`/`postJson` are injected so this module stays decoupled from the app's
 * HTTP helpers (and so browser providers need none).
 *
 * @param {{ api: (path: string) => Promise<any>,
 *           postJson: (path: string, body: any) => Promise<any> }} deps
 */
export function createAdminServerEngineProvider({ api, postJson }) {
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
