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

describe("buildGameSummary (UX P2-9d)", () => {
  it("summarises both sides from the saved classifications", () => {
    const text = buildGameSummary({ moves: GAME });
    expect(text).toMatch(/^Analysis done\./);
    expect(text).toMatch(/White: 1 blunder and 1 inaccuracy\./);
    expect(text).toMatch(/Black: 2 mistakes\./);
    expect(text).toMatch(/14\. a3/); // the first blunder of the game
  });

  it("speaks to the user, and points at their own first error, when they played a side", () => {
    const text = buildGameSummary({ moves: GAME, selfSide: "black" });
    expect(text).toMatch(/You \(Black\): 2 mistakes\./);
    expect(text).toMatch(/Your opponent \(White\): 1 blunder/);
    expect(text).toMatch(/15\.\.\. Bd6, your first mistake/);
    expect(text).not.toMatch(/a3, your/);
  });

  it("credits a clean side and stays empty for an unclassified game", () => {
    const clean = buildGameSummary({ moves: [mv(1, "e4", "best"), mv(2, "e5", "blunder")] });
    expect(clean).toMatch(/White played cleanly\./);
    expect(buildGameSummary({ moves: [mv(1, "e4", null)] })).toBe("");
    expect(hasClassifiedMoves({ moves: [mv(1, "e4", null)] })).toBe(false);
    expect(hasClassifiedMoves({ moves: GAME })).toBe(true);
  });
});
