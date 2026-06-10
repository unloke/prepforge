import { describe, it, expect } from "vitest";

import { localBoardInfo, localBoardAfterMove } from "./chess-local.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("localBoardInfo", () => {
  it("returns 20 legal moves and white to move from the start position", () => {
    const info = localBoardInfo(START);
    expect(info.side_to_move).toBe("white");
    expect(info.legal_moves).toHaveLength(20);
    expect(info.legal_moves).toContain("e2e4");
    expect(info.legal_moves).toContain("g1f3");
    expect(info.status).toEqual({
      is_check: false,
      is_checkmate: false,
      is_stalemate: false,
    });
  });

  it("flags checkmate (fool's mate)", () => {
    const fen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const info = localBoardInfo(fen);
    expect(info.status.is_checkmate).toBe(true);
    expect(info.legal_moves).toHaveLength(0);
  });

  it("emits promotion moves in UCI with the promotion suffix", () => {
    const info = localBoardInfo("8/P7/8/8/8/8/8/k6K w - - 0 1");
    expect(info.legal_moves).toContain("a7a8q");
    expect(info.legal_moves).toContain("a7a8n");
  });
});

describe("localBoardAfterMove", () => {
  it("applies a move and returns server-shaped move + board", () => {
    const out = localBoardAfterMove(START, "e2e4");
    expect(out.move.san).toBe("e4");
    expect(out.move.uci).toBe("e2e4");
    expect(out.move.fen_before).toBe(START);
    expect(out.move.side_to_move).toBe("black");
    expect(out.board.fen).toContain(" b ");
    expect(out.board.legal_moves).toContain("e7e5");
  });

  it("handles promotion UCI", () => {
    const out = localBoardAfterMove("8/P7/8/8/8/8/8/k6K w - - 0 1", "a7a8q");
    expect(out.move.san).toBe("a8=Q+");
  });

  it("throws on an illegal move (callers translate to a status message)", () => {
    expect(() => localBoardAfterMove(START, "e2e5")).toThrow();
  });
});
