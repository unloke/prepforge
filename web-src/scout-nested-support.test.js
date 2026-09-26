import { describe, expect, it } from "vitest";
import { buildOpeningTrie, rankedOpeningBranches, rankGamePlan, fenAfterLine } from "./scout.js";
import { rankPrefilterCandidates } from "./scout-prefilter.js";

const trunk = ["e2e4", "e7e5", "g1f3", "b8c6"];
const child = [...trunk, "f1c4", "f8c5"];

function candidates(childGames) {
  const games = Array.from({ length: 40 + childGames }, (_, i) => ({
    ucis: i < 40 ? trunk : child,
    sans: i < 40 ? ["e4", "e5", "Nf3", "Nc6"] : ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"],
    color: "black", score: 0, gameId: String(i), speed: "blitz",
    datestamp: 1700000000000,
  }));
  const trie = buildOpeningTrie(games, "black", { maxPlies: Infinity });
  return rankedOpeningBranches(games, "black", { trie, limit: 0 }).branches;
}

function prefilter(lines) {
  const evals = new Map(lines.map((line) => [fenAfterLine(line.ucis), {
    score_cp: line.ucis.length > trunk.length ? 35 : 30,
    best_move_uci: "a2a3",
  }]));
  return rankPrefilterCandidates(lines, evals, { fenAfterLine, oppColor: "black" });
}

describe("production nested route support", () => {
  it.each([1, 2])("retains the 40-game trunk over a +5cp child with %i games", (n) => {
    const lines = candidates(n);
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.ucis.length === 4).games).toBe(40);
    const deep = lines.find((line) => line.ucis.length === 6);
    expect(deep.games).toBe(n);
    // Opponent decision plausibility is not personal support for the whole route.
    expect(deep.routeReach).toBeGreaterThan(0.7);
    for (const ordered of [lines, [...lines].reverse()]) {
      const selected = prefilter(ordered);
      expect.soft(selected.map((entry) => entry.line.ucis)).toEqual([trunk]);
      expect.soft(rankGamePlan(selected.map((entry) => ({
        ...entry.line, prefilterScore: entry.prefilterScore,
      })), 50, { oppColor: "black" }).map((line) => line.ucis)).toEqual([trunk]);
      expect.soft(rankGamePlan(ordered, 50, { oppColor: "black" }).map((line) => line.ucis)).toEqual([trunk]);
    }
  });

  it("allows an equally supported child with a better engine score", () => {
    const lines = candidates(40).map((line) => ({
      ...line, prefilterScore: line.ucis.length === 4 ? 30 : 35,
    }));
    expect(prefilter(lines).map((entry) => entry.line.ucis)).toEqual([child]);
    expect(rankGamePlan(lines, 50, { oppColor: "black" }).map((line) => line.ucis)).toEqual([child]);
  });

  it("uses engine score only after equal personal support in the game plan", () => {
    const lines = candidates(40).map((line) => ({
      ...line, prefilterScore: line.ucis.length === 4 ? 35 : 30,
    }));
    for (const ordered of [lines, [...lines].reverse()]) {
      expect(rankGamePlan(ordered, 50, { oppColor: "black" }).map((line) => line.ucis)).toEqual([trunk]);
    }
  });

  it("still rejects opponent decisions below 10% even with strong support", () => {
    const lines = candidates(40).map((line) => ({ ...line, routeReach: 0.09 }));
    expect(prefilter(lines)).toEqual([]);
    expect(rankGamePlan(lines, 50, { oppColor: "black" })).toEqual([]);
  });
});
