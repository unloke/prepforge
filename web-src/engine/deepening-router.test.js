import { describe, expect, it } from "vitest";

import fixture from "./deepening-router.fixture.json";
import model from "./deepening-router-model.json";
import { moveRows, routerDepths, score } from "./deepening-router.js";

// research/analyze-router/fixture.py: three games with made-up screen reads, run through the
// research features, train.py's move features, round10.py's context and predict.mjs on the
// frozen round 11 models.
const evals = new Map(Object.entries(fixture.evals));

describe("deepening router", () => {
  it("builds the research feature rows and scores from browser evals", () => {
    const rows = fixture.games.flatMap((moves) => moveRows(moves, evals));
    // The context columns stay float64, where Math.exp and Python's exp can differ in the last bit.
    expect(rows.length).toBe(fixture.rows.length);
    rows.forEach((row, i) => row.forEach((v, j) => expect(Math.abs(v - fixture.rows[i][j])).toBeLessThan(1e-9)));
    expect(rows.map((row) => score(model.deepen, row))).toEqual(fixture.scores.deepen);
    expect(rows.map((row) => score(model.to20, row))).toEqual(fixture.scores.to20);
  });

  it("sends both positions of a to20 move to depth 20, of a deepen-only move to depth 16", () => {
    const moves = fixture.games[0];
    const want = new Map();
    moves.forEach((m, i) => {
      const d = fixture.scores.to20[i] >= model.to20.threshold ? 20 : fixture.scores.deepen[i] >= model.deepen.threshold ? 16 : 0;
      for (const f of d ? [m.fen_before, m.fen_after] : []) want.set(f, Math.max(want.get(f) || 0, d));
    });
    const depths = [...want.values()];
    expect(depths).toContain(16);
    expect(depths).toContain(20);
    expect(routerDepths(model, moves, evals)).toEqual(want);
  });

  it("reads a position without search history at depth 16, and skips moves without reads", () => {
    const moves = fixture.games[1];
    const off = { deepen: { ...model.deepen, threshold: 2 }, to20: { ...model.to20, threshold: 2 } };
    const quiet = new Map([...evals].map(([fen, ev]) => [fen, { ...ev }]));
    expect(routerDepths(off, moves, quiet).size).toBe(0);
    delete quiet.get(moves[0].fen_after).iterations;
    quiet.delete(moves[2].fen_after);
    expect([...routerDepths(off, moves, quiet)]).toEqual([[moves[0].fen_after, 16]]);
  });
});
