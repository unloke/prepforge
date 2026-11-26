import { describe, expect, it } from "vitest";

import { evalMapFromCache, prefilterCacheKey } from "./scout-prefilter.js";

const fen = (counters) => `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - ${counters}`;

describe("prefilter cache transposition lookup", () => {
  it("finds a complete read of the same position under other move counters", () => {
    const cache = new Map([
      [prefilterCacheKey("8/8/8/8/8/8/8/8 w - - 0 1"), { complete: true, score_cp: 1 }],
      [prefilterCacheKey(fen("3 7")), { complete: true, score_cp: 42 }],
    ]);
    expect(evalMapFromCache([fen("0 1")], cache).get(fen("0 1"))?.score_cp).toBe(42);
    // Another depth is another scope.
    expect(evalMapFromCache([fen("0 1")], cache, 6).size).toBe(0);
  });

  it("sees an incomplete entry completed in place, and entries added later", () => {
    const cache = new Map([[prefilterCacheKey(fen("3 7")), { complete: false }]]);
    expect(evalMapFromCache([fen("0 1")], cache).get(fen("0 1"))).toBeUndefined();
    cache.set(prefilterCacheKey(fen("3 7")), { complete: true, score_cp: 7 }); // same size
    expect(evalMapFromCache([fen("0 1")], cache).get(fen("0 1"))?.score_cp).toBe(7);
    cache.set(prefilterCacheKey(fen("5 9")), { complete: true, score_cp: 9 });
    expect(evalMapFromCache([fen("0 1")], cache).get(fen("0 1"))?.score_cp).toBe(7); // first in cache order
    expect(evalMapFromCache([fen("1 2")], new Map()).size).toBe(0);
  });
});
