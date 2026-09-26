import { describe, expect, it } from "vitest";
import { buildOpeningTrie, rankedOpeningBranches, rankGamePlan, fenAfterLine } from "./scout.js";
import { rankPrefilterCandidates } from "./scout-prefilter.js";

const trunk = ["e2e4", "e7e5", "g1f3", "b8c6"];
const child = [...trunk, "f1c4", "f8c5"];
const trunkSans = ["e4", "e5", "Nf3", "Nc6"];
const childSans = [...trunkSans, "Bc4", "Bc5"];

function makeCandidates(trunkTerminalGames, childGames) {
  const games = Array.from({ length: trunkTerminalGames + childGames }, (_, i) => ({
    ucis: i < trunkTerminalGames ? trunk : child,
    sans: i < trunkTerminalGames ? trunkSans : childSans,
    color: "black", score: 0, gameId: String(i), speed: "blitz",
    datestamp: 1700000000000,
  }));
  const trie = buildOpeningTrie(games, "black", { maxPlies: Infinity });
  return rankedOpeningBranches(games, "black", { trie, limit: 0 }).branches;
}

function candidates(childGames) {
  return makeCandidates(40, childGames);
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

describe("routeSupportGames semantics", () => {
  it("trunk and child report exact terminal games vs full-route support (40 + 40)", () => {
    const lines = candidates(40);
    const trunkLine = lines.find((line) => line.ucis.length === 4);
    const childLine = lines.find((line) => line.ucis.length === 6);
    // games = exact terminal branch count.
    expect(trunkLine.games).toBe(40);
    expect(childLine.games).toBe(40);
    // routeSupportGames = personal games reaching the complete route (trie prefix gameCount).
    expect(trunkLine.routeSupportGames).toBe(80);
    expect(childLine.routeSupportGames).toBe(40);
    // routeReach = weakest sample-aware opponent conditional decision probability.
    expect(childLine.routeReach).toBeGreaterThan(0.7);
    expect(childLine.routeReach).toBeLessThanOrEqual(1);
  });

  it("keeps games, routeSupportGames and routeReach semantically distinct", () => {
    const lines = candidates(40);
    const trunkLine = lines.find((line) => line.ucis.length === 4);
    // games counts exact terminal games only; routeSupportGames counts full-route games.
    expect(trunkLine.games).not.toBe(trunkLine.routeSupportGames);
    // routeReach is a 0..1 opponent-decision probability, never a game count.
    expect(trunkLine.routeReach).toBeLessThanOrEqual(1);
    expect(trunkLine.routeReach).not.toBe(trunkLine.routeSupportGames);
  });

  it.each([
    [1, 1, 2],
    [2, 2, 4],
  ])(
    "sparse corpus %i trunk-terminal / %i child games gives trunk support %i",
    (trunkTerminalGames, childGames, trunkSupport) => {
      const lines = makeCandidates(trunkTerminalGames, childGames);
      const trunkLine = lines.find((line) => line.ucis.length === 4);
      const childLine = lines.find((line) => line.ucis.length === 6);
      expect(trunkLine.games).toBe(trunkTerminalGames);
      expect(childLine.games).toBe(childGames);
      expect(trunkLine.routeSupportGames).toBe(trunkSupport);
      expect(childLine.routeSupportGames).toBe(childGames);
      expect(trunkLine.games).not.toBe(trunkLine.routeSupportGames);
      expect(trunkLine.routeReach).not.toBe(trunkLine.routeSupportGames);
      expect(childLine.routeReach).not.toBe(childLine.routeSupportGames);
    },
  );

  it("threads routeSupportGames through the prefilter and the final game plan", () => {
    const lines = candidates(1);
    for (const ordered of [lines, [...lines].reverse()]) {
      const selected = prefilter(ordered);
      // 1b7b28f nested rule unchanged: the 40-game trunk survives, and its
      // full-route support travels with it into the prefilter result.
      expect.soft(selected.map((entry) => entry.line.ucis)).toEqual([trunk]);
      expect.soft(selected.map((entry) => entry.routeSupportGames)).toEqual([41]);
      const plan = rankGamePlan(selected.map((entry) => ({
        ...entry.line, prefilterScore: entry.prefilterScore,
      })), 50, { oppColor: "black" });
      expect.soft(plan.map((line) => line.ucis)).toEqual([trunk]);
      expect.soft(plan.map((line) => line.routeSupportGames)).toEqual([41]);
      const directPlan = rankGamePlan(ordered, 50, { oppColor: "black" });
      expect.soft(directPlan.map((line) => line.ucis)).toEqual([trunk]);
      expect.soft(directPlan.map((line) => line.routeSupportGames)).toEqual([41]);
    }
  });
});
