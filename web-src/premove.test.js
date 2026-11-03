import { describe, expect, it } from "vitest";
import { localBoardAfterMove, localPremoveMoves } from "./chess-local.js";
import { START_FEN } from "./train-play.js";

describe("premove destinations", () => {
  it("offers the player's pieces during the opponent's turn", () => {
    const fen = localBoardAfterMove(START_FEN, "e2e4").board.fen;
    const moves = localPremoveMoves(fen, "white");
    expect(moves).toContain("g1f3");
    expect(moves).toContain("e4d5"); // a future capture
    expect(moves).not.toContain("e7e5");
    expect(moves).not.toContain("a1a4"); // blocked rook
    expect(moves).not.toContain("e4e6");
  });
  it("keeps all promotion choices for either colour", () => {
    for (const [fen, color, prefix] of [
      ["8/P6k/8/8/8/8/6K1/8 b - - 0 1", "white", "a7a8"],
      ["8/7k/8/8/8/8/p5K1/8 w - - 0 1", "black", "a2a1"],
    ]) {
      expect(localPremoveMoves(fen, color).filter((move) => move.startsWith(prefix)))
        .toEqual(["q", "r", "b", "n"].map((p) => prefix + p));
    }
  });
  it("only offers castling with rights and a clear path", () => {
    const fen = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1";
    expect(localPremoveMoves(fen, "white")).toContain("e1g1");
    expect(localPremoveMoves(fen.replace("KQkq", "-"), "white")).not.toContain("e1g1");
    expect(localPremoveMoves(START_FEN, "white")).not.toContain("e1g1");
  });
});
