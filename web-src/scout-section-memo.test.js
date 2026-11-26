import { describe, expect, it, vi } from "vitest";

import { memoRankedOpeningBranches, memoScoutStats } from "./scout-section-memo.js";

describe("scout section memo", () => {
  it("reuses the ranked branches until the games, trie or filter change", () => {
    const rankedOpeningBranches = vi.fn(() => ({ branches: [], ancestorFreq: new Map() }));
    const scoutModule = { rankedOpeningBranches };
    const games = [{ color: "white" }];
    const trie = { gameCount: 1, count: 1 };
    const opts = () => ({ speedFilter: "all", trie, baselineScorePct: 50, limit: 40 });

    const first = memoRankedOpeningBranches(scoutModule, games, "white", opts());
    expect(memoRankedOpeningBranches(scoutModule, games, "white", opts())).toBe(first);
    expect(rankedOpeningBranches).toHaveBeenCalledTimes(1);

    // A streamed game grows the same array and the live trie in place.
    games.push({ color: "white" });
    trie.gameCount = 2;
    memoRankedOpeningBranches(scoutModule, games, "white", opts());
    expect(rankedOpeningBranches).toHaveBeenCalledTimes(2);

    memoRankedOpeningBranches(scoutModule, games, "white", { ...opts(), speedFilter: "blitz" });
    memoRankedOpeningBranches(scoutModule, games, "white", { ...opts(), baselineScorePct: 40 });
    expect(rankedOpeningBranches).toHaveBeenCalledTimes(4);

    // Each colour keeps its own result: drawing Black does not evict White.
    memoRankedOpeningBranches(scoutModule, games, "black", opts());
    memoRankedOpeningBranches(scoutModule, games, "white", { ...opts(), baselineScorePct: 40 });
    expect(rankedOpeningBranches).toHaveBeenCalledTimes(5);
  });

  it("reuses the colour stats for the same games and speed", () => {
    const games = [
      { color: "white", score: 1, ucis: ["e2e4"], sans: ["e4"], speed: "blitz", datestamp: 1 },
    ];
    const first = memoScoutStats(games, { color: "white", speedFilter: "all" });
    expect(memoScoutStats(games, { color: "white", speedFilter: "all" })).toBe(first);
    expect(memoScoutStats(games.slice(), { color: "white", speedFilter: "all" })).not.toBe(first);
  });
});
