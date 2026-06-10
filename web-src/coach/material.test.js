import { describe, it, expect } from "vitest";

import {
  materialBalance,
  perPieceDiff,
  capturedLists,
  materialPhrase,
  pieceListPhrase,
  walkLine,
  gamePhase,
  squareExchange,
  settledBalanceAfter,
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

describe("squareExchange (single-square SEE) — the phantom-pawn fix", () => {
  it("reads an even pawn trade as level, not a pawn up", () => {
    // 1.e4 d5 2.exd5 — White has just taken the d5 pawn; Black recaptures with the queen.
    // A naive count says White +1; the settled count prices in the recapture → level.
    const afterExd5 = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
    expect(materialBalance(new Chess(afterExd5))).toBe(1); // raw, mid-exchange
    expect(squareExchange(new Chess(afterExd5), "d5")).toBe(0); // settled: recapture priced in
  });

  it("keeps a genuinely won pawn when there is no recapture", () => {
    // 1.d4 c5 2.dxc5 — nothing attacks c5, so White is honestly a pawn up: +1 stands.
    const afterDxc5 = "rnbqkbnr/pp1ppppp/8/2P5/8/8/PPP1PPPP/RNBQKBNR b KQkq - 0 2";
    expect(squareExchange(new Chess(afterDxc5), "c5")).toBe(1);
  });

  it("does not invent captures on other squares (no greedy grabbing)", () => {
    // A loose black pawn sits on a7-file (a5), but the contested square is e4. Resolving
    // e4 must not also 'win' the a5 pawn — we only finish the trade in front of us.
    const fen = "4k3/8/8/p7/4p3/3P4/8/4K3 w - - 0 1";
    // White to move, down a pawn (-1). dxe4 wins back the e4 pawn → level (0). The loose
    // a5 pawn is NOT on the contested square, so it is never swept up: the result is 0,
    // not +1. Greedy whole-board resolution would have wrongly grabbed a5 too.
    expect(squareExchange(new Chess(fen), "e4")).toBe(0);
  });

  it("settledBalanceAfter only resolves when the move was a capture", () => {
    const quiet = walkLine("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", ["g1f3"]);
    // A quiet developing move starts no exchange — settled == raw.
    expect(quiet.settledEndBalance).toBe(quiet.endBalance);
  });
});

describe("walkLine settled swing — honest exchange accounting", () => {
  it("reports an even recapture exchange as zero swing", () => {
    // 1.e4 d5 2.exd5 Qxd5 — pawns are swapped, queen recaptures: dead level.
    const fen = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    const line = walkLine(fen, ["e4d5", "d8d5"]);
    expect(line.settledSwing).toBe(0);
  });

  it("when the line stops mid-exchange, settled swing still reads level", () => {
    // Same trade but the PV truncates right after exd5 (no recapture ply). Raw swing
    // would wrongly show +1; settled resolves the pending recapture to 0.
    const fen = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    const line = walkLine(fen, ["e4d5"]);
    expect(line.swing).toBe(1); // raw, mid-exchange
    expect(line.settledSwing).toBe(0); // honest
  });
});

describe("gamePhase", () => {
  it("calls the start an opening and a bare-pieces position an endgame", () => {
    expect(gamePhase(START)).toBe("opening");
    expect(gamePhase("4k3/8/8/8/8/8/4P3/4K3 w - - 0 40")).toBe("endgame");
  });
});
