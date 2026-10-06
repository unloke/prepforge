import { describe, expect, it } from "vitest";

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
        const read = depth === 12 ? ev(fen === "C" ? 200 : 30) : ev(fen === "C" ? 150 : 25, { depth });
        out.set(fen, read);
        onResult(fen, read);
      }
      return out;
    };
    const finals = [];
    const { evals, screenDepth } = await analyzeTiered({
      analyze, positions: ["A", "B", "C"], moves, depth: 16,
      onFinal: (fen, read) => finals.push([fen, read.depth]),
    });
    expect(screenDepth).toBe(12);
    expect(calls).toEqual([{ positions: ["A", "B", "C"], depth: 12 }, { positions: ["B", "C"], depth: 16 }]);
    expect(finals.sort()).toEqual([["A", 12], ["B", 16], ["C", 16]]);
    expect(evals.get("A").depth).toBe(12);
    expect(evals.get("C").score_cp).toBe(150);
  });
  it("runs one full-depth pass when the depth is too low to tier", async () => {
    const calls = [];
    const analyze = async ({ positions, depth }) => { calls.push(depth); return new Map(positions.map((f) => [f, ev(0)])); };
    const { screenDepth } = await analyzeTiered({ analyze, positions: ["A", "B", "C"], moves, depth: 10 });
    expect(screenDepth).toBe(null);
    expect(calls).toEqual([10]);
  });
});
