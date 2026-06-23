import { describe, expect, it } from "vitest";

import {
  MAIA_ENRICH_PARTIAL,
  globalMaiaPoolNeedsWork,
  resetMaiaScopeCache,
} from "../scout-maia.js";

describe("Maia attempt budget on scope change", () => {
  it("allows new reads after scope change when the prior scope exhausted maxAttempts", () => {
    const maiaResults = new Map();
    const rankedEntries = Array.from({ length: 24 }, (_, i) => ({
      oppColor: "white",
      line: { ucis: [`m${i}`], sans: [`m${i}`], games: 1 },
      prefilterScore: 100 - i,
    }));
    const context = {
      successTarget: 12,
      maxAttempts: 24,
      attemptsUsed: 24,
      maiaResults,
      getRating: () => 1800,
      fenAfterLine: (ucis) => `fen-${ucis[0]}`,
    };

    expect(globalMaiaPoolNeedsWork(rankedEntries, context)).toBe(false);

    const state = {
      maiaScopeKey: "all|10|1800|1750",
      maiaResults,
      maiaCache: new Map(),
      maiaEnrichState: MAIA_ENRICH_PARTIAL,
      maiaAttemptsUsed: 24,
    };
    if (resetMaiaScopeCache(state, "all|11|1800|1750")) {
      state.maiaAttemptsUsed = 0;
    }

    expect(
      globalMaiaPoolNeedsWork(rankedEntries, { ...context, attemptsUsed: state.maiaAttemptsUsed }),
    ).toBe(true);
  });
});