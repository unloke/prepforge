import { describe, it, expect } from "vitest";

import {
  materialBalance,
  perPieceDiff,
  capturedLists,
  materialPhrase,
  pieceListPhrase,
  walkLine,
  gamePhase,
} from "./material.js";
import { Chess } from "chess.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("material counting", () => {
  it("reads the start position as balanced", () => {
    expect(materialBalance(new Chess(START))).toBe(0);
    expect(perPieceDiff(new Chess(START))).toEqual({ p: 0, n: 0, b: 0, r: 0, q: 0 });
  });

  it("scores a missing black queen as +9 for White", () => {
    const fen = "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    expect(materialBalance(new Chess(fen))).toBe(9);
    expect(capturedLists(new Chess(fen)).byWhite).toEqual({ q: 1 });
  });
});

describe("materialPhrase", () => {
  it("names common edges", () => {
    expect(materialPhrase(0)).toBe("");
    expect(materialPhrase(1)).toBe("a pawn");
    expect(materialPhrase(3)).toBe("a piece");
    expect(materialPhrase(5)).toBe("a rook");
    expect(materialPhrase(-9)).toBe("a queen");
  });
});

describe("pieceListPhrase", () => {
  it("lists captured pieces richest-first", () => {
    expect(pieceListPhrase({ p: 2, n: 1 })).toBe("a knight, 2 pawns");
  });
});

describe("walkLine", () => {
  it("tracks a capture and the resulting balance", () => {
    // 1.e4 d5 2.exd5 — White nets a pawn.
    const fen = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    const line = walkLine(fen, ["e4d5"]);
    expect(line.byWhite).toEqual({ p: 1 });
    expect(line.swing).toBe(1);
    expect(line.advantage).toBe("white");
  });

  it("flags a line that liquidates to a dead draw", () => {
    const line = walkLine("8/8/8/8/8/8/8/k1K1B3 w - - 0 1", []);
    expect(line.insufficient).toBe(true);
  });
});

describe("gamePhase", () => {
  it("calls the start an opening and a bare-pieces position an endgame", () => {
    expect(gamePhase(START)).toBe("opening");
    expect(gamePhase("4k3/8/8/8/8/8/4P3/4K3 w - - 0 40")).toBe("endgame");
  });
});
