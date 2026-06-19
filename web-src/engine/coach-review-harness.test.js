import { describe, it, expect } from "vitest";

import { splitPgnGames, gameToMoves, renderBoard } from "./coach-review-harness.js";

const GAME = `[Event "Casual"]
[White "alice"]
[Black "bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;

describe("coach-review harness — PGN parsing", () => {
  it("splits a multi-game PGN into separate games", () => {
    const two = `${GAME}\n\n${GAME.replace("alice", "carol")}`;
    expect(splitPgnGames(two)).toHaveLength(2);
    expect(splitPgnGames("")).toHaveLength(0);
  });

  it("turns a game into per-move records with before/after FENs and UCIs", () => {
    const { headers, moves } = gameToMoves(GAME);
    expect(headers.White).toBe("alice");
    expect(moves).toHaveLength(6); // e4 e5 Nf3 Nc6 Bb5 a6
    const first = moves[0];
    expect(first).toMatchObject({ ply: 1, san: "e4", uci: "e2e4", mover: "white" });
    expect(first.fenBefore.startsWith("rnbqkbnr/pppppppp")).toBe(true);
    // Each move's fenAfter is the next move's fenBefore (a consistent replay).
    expect(moves[0].fenAfter).toBe(moves[1].fenBefore);
    expect(moves[2]).toMatchObject({ ply: 3, san: "Nf3", uci: "g1f3", mover: "white" });
    expect(moves[1].mover).toBe("black");
  });

  it("returns null for unparseable PGN", () => {
    expect(gameToMoves("not a pgn at all {{{")).toBeNull();
  });
});

describe("coach-review harness — board render", () => {
  it("renders 64 squares and highlights the move's from/to", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const html = renderBoard(fen, "e2", "e4");
    expect((html.match(/cr-sq/g) || []).length).toBe(64);
    expect((html.match(/cr-hl/g) || []).length).toBe(2); // e2 and e4
    expect(html).toContain("♙"); // a white pawn glyph is present
  });
});
