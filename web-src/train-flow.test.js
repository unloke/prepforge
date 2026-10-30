import { describe, expect, it } from "vitest";
import { planTrainRunIn } from "./train-flow.js";

const e4 = { uci: "e2e4", fen_after: "e4" };
const e5 = { uci: "e7e5", fen_after: "e5" };
const nf3 = { uci: "g1f3", fen_after: "nf3" };
const nc6 = { uci: "b8c6", fen_after: "nc6" };
const d6 = { uci: "d7d6", fen_after: "d6" };
const prompt = (moves, target_index = 0) => ({
  run_in: moves, start_fen: "root", fen_before: moves.at(-1)?.fen_after || "root", target_index,
});

describe("continuous opening context", () => {
  it("plays the context on the first line", () => {
    expect(planTrainRunIn(prompt([e4, e5]), "root")).toMatchObject({ startFen: "root", moves: [e4, e5] });
  });
  it("changes only the opponent's branch after a shared opening", () => {
    const plan = planTrainRunIn(prompt([e4, e5, nf3, d6]), "nc6", [e4, e5, nf3, nc6]);
    expect(plan).toMatchObject({ startFen: "nf3", moves: [d6] });
  });
  it("continues from the board's current position without replaying it", () => {
    expect(planTrainRunIn(prompt([nf3, nc6], 1), "e5", [e4, e5])).toMatchObject({
      startFen: "e5", moves: [nf3, nc6], path: [e4, e5, nf3, nc6],
    });
  });
  it("does not animate a position already on the board", () => {
    expect(planTrainRunIn(prompt([e4, e5]), "e5").moves).toEqual([]);
  });
  it("keeps unrelated openings separate even if the last move has the same notation", () => {
    const other = { uci: e4.uci, fen_after: "different-e4-position" };
    expect(planTrainRunIn(prompt([e4, e5]), "other", [other])).toMatchObject({
      startFen: "root", moves: [e4, e5],
    });
  });
});
