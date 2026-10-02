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
  const rows = rankedOpeningBranches(games, "black", { trie, limit: 0 }).branches;
  return rows.map(r => ({ ...r, selectionBaseline: { score: 0.7, prior: { w: 0.7, d: 0, l: 0.3 } } }));
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
  it.each([1, 2])("anchors a continuation seen in %i games on its supported trunk", (n) => {
    const lines = candidates(n);
    expect(lines).toHaveLength(2);
    const short = lines.find((line) => line.ucis.length === 4);
    const deep = lines.find((line) => line.ucis.length === 6);
    expect(short.games).toBe(40);
    expect(deep.games).toBe(n);
    expect(deep.exactGames).toBe(n);
    // Too few games to judge the deep move itself: its evidence is the trunk.
    expect(deep.anchorUcis).toEqual(trunk);
    expect(deep.routeSupportGames).toBe(40 + n);
    expect(deep.routeReach).toBeGreaterThan(0.7);
    for (const ordered of [lines, [...lines].reverse()]) {
      // Same trunk evidence: the deeper line's better engine read (35 vs 30) puts it first.
      expect(prefilter(ordered).map((entry) => entry.line.ucis)).toEqual([child, trunk]);
      // Without engine reads, the trunk's most-played continuation leads.
      expect(rankGamePlan(ordered, 50, { oppColor: "black" }).map((line) => line.ucis)).toEqual([trunk, child]);
    }
  });

  it("judges a well-played continuation on its own games", () => {
    const lines = candidates(40);
    const deep = lines.find((line) => line.ucis.length === 6);
    expect(deep.anchorUcis).toEqual(child);
    expect(deep.routeSupportGames).toBe(40);
    for (const ordered of [lines, [...lines].reverse()])
      expect(rankGamePlan(ordered, 50, { oppColor: "black" }).map((line) => line.ucis).sort()).toEqual([child, trunk].sort());
  });

  it("still rejects opponent decisions below 10% even with strong support", () => {
    const lines = candidates(40).map((line) => ({ ...line, routeReach: 0.09 }));
    expect(prefilter(lines)).toEqual([]);
    expect(rankGamePlan(lines, 50, { oppColor: "black" })).toEqual([]);
  });
});

describe("routeSupportGames semantics", () => {
  it("lists only observed full lines, each anchored where the games diverge", () => {
    const records = Array.from({length:20},(_,i) => ({
      color:'black',speed:'blitz',gameId:String(i),score:0,
      ucis: [...trunk, ...(i < 10 ? ['f1c4','f8c5'] : ['f1b5','a7a6'])],
      sans: [...trunkSans, ...(i < 10 ? ['Bc4','Bc5'] : ['Bb5','a6'])],
    }));
    const trie = buildOpeningTrie(records,'black',{maxPlies:Infinity});
    const rows = rankedOpeningBranches(records,'black',{trie,limit:0}).branches;
    expect(rows.map(r => r.ucis.length)).toEqual([6, 6]);
    for (const row of rows) {
      expect(row.routeSupportGames).toBe(10);
      expect(row.evidenceGames).toBe(20);
    }
  });
  it("keeps evaluated opportunity on prefilter line objects used by reports", () => {
    const entries = prefilter(candidates(1));
    expect(entries.every(e => e.line.prefilterScore === e.prefilterScore)).toBe(true);
    expect(entries[0].line.evidenceGames).toBe(41);
    expect(rankGamePlan(entries.map(e => e.line),50,{oppColor:'black'})[0].preparationEvidence.opportunity).toBeGreaterThan(0.1);
  });
  it("trunk and child report exact terminal games vs anchor support (40 + 40)", () => {
    const lines = candidates(40);
    const trunkLine = lines.find((line) => line.ucis.length === 4);
    const childLine = lines.find((line) => line.ucis.length === 6);
    // games = exact terminal branch count.
    expect(trunkLine.games).toBe(40);
    expect(childLine.games).toBe(40);
    // routeSupportGames = games reaching the line's anchor (here the full line).
    expect(trunkLine.routeSupportGames).toBe(80);
    expect(childLine.routeSupportGames).toBe(40);
    // routeReach = weakest sample-aware opponent conditional decision probability.
    expect(childLine.routeReach).toBeGreaterThan(0.7);
    expect(childLine.routeReach).toBeLessThanOrEqual(1);
  });

  it("keeps games, routeSupportGames and routeReach semantically distinct", () => {
    const lines = candidates(40);
    const trunkLine = lines.find((line) => line.ucis.length === 4);
    expect(trunkLine.games).not.toBe(trunkLine.routeSupportGames);
    expect(trunkLine.routeReach).toBeLessThanOrEqual(1);
    expect(trunkLine.routeReach).not.toBe(trunkLine.routeSupportGames);
  });

  it("leaves a line with no supported prefix unanchored and out of the plan", () => {
    const lines = makeCandidates(1, 1);
    for (const line of lines) {
      expect(line.anchorUcis).toEqual([]);
      expect(line.routeSupportGames).toBe(0);
    }
    expect(rankGamePlan(lines, 50, { oppColor: "black" })).toEqual([]);
  });

  it("sparse corpus 2 trunk-terminal / 2 child games anchors both rows on the trunk", () => {
    const lines = makeCandidates(2, 2);
    for (const line of lines) {
      expect(line.anchorUcis).toEqual(trunk);
      expect(line.routeSupportGames).toBe(4);
      expect(line.exactGames).toBe(line.ucis.length === 4 ? 4 : 2);
    }
  });

  it("threads routeSupportGames through the prefilter and the final game plan", () => {
    const lines = candidates(1);
    for (const ordered of [lines, [...lines].reverse()]) {
      const selected = prefilter(ordered);
      expect.soft(selected.map((entry) => entry.routeSupportGames)).toEqual([41, 41]);
      const plan = rankGamePlan(selected.map((entry) => ({
        ...entry.line, prefilterScore: entry.prefilterScore,
      })), 50, { oppColor: "black" });
      expect.soft(plan.map((line) => line.ucis)).toEqual([child, trunk]);
      expect.soft(plan.map((line) => line.routeSupportGames)).toEqual([41, 41]);
    }
  });

  it("labels a weak spot by its anchor evidence, not the single game behind the line", () => {
    // The deep line was played once and won by the opponent; the trunk is where they lose.
    const lines = candidates(1).map((line) => line.ucis.length === 6
      ? { ...line, w: 1, d: 0, l: 0, scorePct: 100 } : line);
    const deep = rankGamePlan(lines, 50, { oppColor: "black" }).find((line) => line.ucis.length === 6);
    expect(deep.preparationEvidence.value).toBeGreaterThan(0);
    expect(deep.prepCategory).toBe("attack");
    expect(deep.belowBaseline).toBe(50);
  });
});
