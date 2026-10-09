import { describe, it, expect } from "vitest";
import { buildGameSummary, hasClassifiedMoves } from "./game-summary.js";

const mv = (ply, san, classification) => ({
  ply,
  move_number: Math.ceil(ply / 2),
  side: ply % 2 ? "white" : "black",
  san,
  classification,
});

const GAME = [
  mv(1, "e4", "book"),
  mv(2, "c6", "book"),
  mv(27, "a3", "blunder"),
  mv(28, "d5", "best"),
  mv(29, "Bb3", "inaccuracy"),
  mv(30, "Bd6", "mistake"),
  mv(32, "Qe7", "mistake"),
];

describe("buildGameSummary", () => {
  it("summarises both sides from the saved classifications", () => {
    expect(buildGameSummary({ moves: GAME })).toEqual({
      text: "White: 1 blunder, 1 inaccuracy. Black: 2 mistakes.",
      turningPoint: { ply: 27, label: "14.a3" },
    });
  });

  it("speaks to the user and points at their own first error when they played a side", () => {
    expect(buildGameSummary({ moves: GAME, selfSide: "black" })).toEqual({
      text: "You: 2 mistakes. Opponent: 1 blunder, 1 inaccuracy.",
      turningPoint: { ply: 30, label: "15...Bd6" },
    });
  });

  it("credits a clean side and stays empty for an unclassified game", () => {
    expect(buildGameSummary({ moves: [mv(1, "e4", "best"), mv(2, "e5", "blunder")] })).toEqual({
      text: "White: no errors. Black: 1 blunder.",
      turningPoint: { ply: 2, label: "1...e5" },
    });
    expect(buildGameSummary({ moves: [mv(1, "e4", "best")] }).turningPoint).toBeNull();
    expect(buildGameSummary({ moves: [mv(1, "e4", null)] })).toBeNull();
    expect(hasClassifiedMoves({ moves: [mv(1, "e4", null)] })).toBe(false);
    expect(hasClassifiedMoves({ moves: GAME })).toBe(true);
  });
});
