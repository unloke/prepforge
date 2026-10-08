import { describe, expect, it } from "vitest";

import fixture from "./deepening-router.fixture.json";
import model from "./deepening-router-model.json";
import { routerFlags } from "./deepening-router.js";
import { analyzeTiered, deepFlags, screenDepthFor } from "./tiered-analysis.js";

const ev = (cp, extra = {}) => ({ score_cp: cp, mate_in: null, depth: 12, ...extra });

describe("screenDepthFor", () => {
  it("drops four plies from the analysis depth, and doesn't tier a shallow analysis", () => {
    expect(screenDepthFor(16)).toBe(12);
    expect(screenDepthFor(20)).toBe(16);
    expect(screenDepthFor(12)).toBe(8);
    expect(screenDepthFor(11)).toBe(null);
  });
});

describe("deepFlags", () => {
  const moves = [
    { side: "white", fen_before: "A", fen_after: "B" },
    { side: "black", fen_before: "B", fen_after: "C" },
    { side: "white", fen_before: "C", fen_after: "D" },
  ];
  it("flags both positions of a move that loses a point or more, and of any mate", () => {
    const evals = new Map([["A", ev(30)], ["B", ev(30)], ["C", ev(80)], ["D", ev(80, { score_cp: null, mate_in: 5 })]]);
    // A→B keeps 0; B→C (black) loses ~4.6 points; C→D shows a mate.
    expect([...deepFlags(moves, evals)].sort()).toEqual(["B", "C", "D"]);
  });
  it("leaves a quiet best move on its screen read", () => {
    const evals = new Map([["A", ev(30)], ["B", ev(28)], ["C", ev(29)], ["D", ev(29)]]);
    expect(deepFlags(moves, evals).size).toBe(0);
  });
});

describe("analyzeTiered", () => {
  const moves = [
    { side: "white", fen_before: "A", fen_after: "B" },
    { side: "black", fen_before: "B", fen_after: "C" },
  ];
  it("screens every position, re-reads only the flagged ones at full depth, and reports each final read once", async () => {
    const calls = [];
    const analyze = async ({ positions, depth, onResult }) => {
      calls.push({ positions, depth });
      const out = new Map();
      for (const fen of positions) {
        const read = depth === 16 ? ev(fen === "C" ? 200 : 30, { depth }) : ev(fen === "C" ? 150 : 25, { depth });
        out.set(fen, read);
        onResult(fen, read);
      }
      return out;
    };
    const finals = [];
    const { evals, screenDepth } = await analyzeTiered({
      analyze, positions: ["A", "B", "C"], moves, depth: 20,
      onFinal: (fen, read) => finals.push([fen, read.depth]),
    });
    expect(screenDepth).toBe(16);
    expect(calls).toEqual([{ positions: ["A", "B", "C"], depth: 16 }, { positions: ["B", "C"], depth: 20 }]);
    expect(finals.sort()).toEqual([["A", 16], ["B", 20], ["C", 20]]);
    expect(evals.get("A").depth).toBe(16);
    expect(evals.get("C").score_cp).toBe(150);
  });
  it("lets the router pick the deep positions at depth 16", async () => {
    const moves = fixture.games[0];
    const positions = [...new Set(moves.flatMap((m) => [m.fen_before, m.fen_after]))];
    const calls = [];
    const analyze = async ({ positions: fens, depth }) => {
      calls.push({ n: fens.length, depth });
      return new Map(fens.map((f) => [f, depth === 12 ? fixture.evals[f] : ev(0, { depth })]));
    };
    const { evals, screenDepth } = await analyzeTiered({ analyze, positions, moves, depth: 16 });
    const want = routerFlags(model, moves, new Map(Object.entries(fixture.evals)));
    expect(screenDepth).toBe(12);
    expect(calls).toEqual([{ n: positions.length, depth: 12 }, { n: want.size, depth: 16 }]);
    expect(positions.filter((f) => evals.get(f).depth === 16)).toEqual(positions.filter((f) => want.has(f)));
  });
  it("runs one full-depth pass when the depth is too low to tier", async () => {
    const calls = [];
    const analyze = async ({ positions, depth }) => { calls.push(depth); return new Map(positions.map((f) => [f, ev(0)])); };
    const { screenDepth } = await analyzeTiered({ analyze, positions: ["A", "B", "C"], moves, depth: 10 });
    expect(screenDepth).toBe(null);
    expect(calls).toEqual([10]);
  });
});
