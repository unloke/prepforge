import { describe, it, expect } from "vitest";

import { isTerminalPosition, terminalEval } from "./game-analyzer.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// Fool's mate: 1. f3 e5 2. g4 Qh4# — Black has delivered mate, White to move.
const WHITE_MATED_FEN =
  "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
// Scholar's mate: after Qxf7#, Black is checkmated, Black to move.
const BLACK_MATED_FEN =
  "r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4";
// Classic stalemate: Black to move, no legal moves, not in check.
const STALEMATE_FEN = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";

describe("isTerminalPosition", () => {
  it("is false for a normal position with legal moves", () => {
    expect(isTerminalPosition(START_FEN)).toBe(false);
  });

  it("is true for checkmate and stalemate (so the engine is skipped)", () => {
    expect(isTerminalPosition(WHITE_MATED_FEN)).toBe(true);
    expect(isTerminalPosition(BLACK_MATED_FEN)).toBe(true);
    expect(isTerminalPosition(STALEMATE_FEN)).toBe(true);
  });

  it("is false (not terminal) for an unparseable FEN", () => {
    expect(isTerminalPosition("not a fen")).toBe(false);
  });
});

describe("terminalEval", () => {
  it("saturates negative when White is checkmated", () => {
    const ev = terminalEval(WHITE_MATED_FEN);
    expect(ev.score_cp).toBe(-100000);
    expect(ev.best_move_uci).toBe(null);
  });

  it("saturates positive when Black is checkmated", () => {
    const ev = terminalEval(BLACK_MATED_FEN);
    expect(ev.score_cp).toBe(100000);
  });

  it("is a draw (0) for stalemate", () => {
    const ev = terminalEval(STALEMATE_FEN);
    expect(ev.score_cp).toBe(0);
  });
});
