import { describe, expect, it } from "vitest";

import fixture from "./deepening-router.fixture.json";
import model from "./deepening-router-model.json";
import { moveRows, routerFlags, score } from "./deepening-router.js";

// research/analyze-router/fixture.py: three games with made-up screen reads, run through the
// research features, train.py's move features and predict.mjs on the frozen model.
const evals = new Map(Object.entries(fixture.evals));

describe("deepening router", () => {
  it("builds the research feature rows and scores from browser evals", () => {
    const rows = fixture.games.flatMap((moves) => moveRows(moves, evals));
    expect(rows).toEqual(fixture.rows);
    expect(rows.map((row) => score(model, row))).toEqual(fixture.scores);
  });

  it("deepens both positions of each flagged move", () => {
    const moves = fixture.games[0];
    const scores = fixture.scores.slice(0, moves.length);
    const want = new Set(moves.flatMap((m, i) => (scores[i] >= model.threshold ? [m.fen_before, m.fen_after] : [])));
    expect(want.size).toBeGreaterThan(0);
    expect(want.size).toBeLessThan(moves.length + 1);
    expect(routerFlags(model, moves, evals)).toEqual(want);
  });

  it("deepens a position whose screen read has no search history, and skips moves without reads", () => {
    const moves = fixture.games[1];
    const quiet = new Map([...evals].map(([fen, ev]) => [fen, { ...ev }]));
    const flagged = routerFlags({ ...model, threshold: 2 }, moves, quiet);
    expect(flagged.size).toBe(0);
    delete quiet.get(moves[0].fen_after).iterations;
    quiet.delete(moves[2].fen_after);
    expect([...routerFlags({ ...model, threshold: 2 }, moves, quiet)]).toEqual([moves[0].fen_after]);
  });
});
