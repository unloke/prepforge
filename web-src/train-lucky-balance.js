import { waitForEngineSearch } from "./engine/engine-search-wait.js";

export const LUCKY_MAX_ABS_CP = 150;

export function balancedPracticeEval(pv) {
  return !!pv && pv.mate_in == null && typeof pv.score_cp === "number"
    && Number.isFinite(pv.score_cp) && Math.abs(pv.score_cp) <= LUCKY_MAX_ABS_CP;
}

// One worker per click, reused while checking candidates and always released.
export function createLuckyBalanceCheck() {
  let provider = null;
  return {
    async evaluate(fen) {
      if (!provider) {
        const { createStockfishWasmProvider } = await import("./engine/stockfish-provider.js");
        provider = createStockfishWasmProvider({ maxDepth: 14, maxNodes: 250000, priority: "interactive" });
      }
      await provider.open({ fen, multipv: 1 });
      const snap = await waitForEngineSearch(provider, { targetDepth: 14, timeoutMs: 10000, fen });
      return snap.pvs[0];
    },
    close() { provider?.close(); },
  };
}
