import { describe, it, expect } from "vitest";

import {
  materialBalance,
  perPieceDiff,
  materialPhrase,
  materialEdgePhrase,
  materialSwingPhrase,
  walkLine,
  gamePhase,
  squareExchange,
  squareExchangeBoard,
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

describe("materialEdgePhrase (composition: the exchange vs two pawns)", () => {
  it("names a rook-for-minor imbalance 'the exchange', not 'two pawns'", () => {
    expect(materialEdgePhrase({ p: 0, n: 0, b: -1, r: 1, q: 0 }, 2)).toBe("the exchange");
    expect(materialEdgePhrase({ p: 0, n: -1, b: 0, r: 1, q: 0 }, 2)).toBe("the exchange");
  });

  it("rides extra pawns onto the exchange", () => {
    expect(materialEdgePhrase({ p: 1, b: -1, r: 1, q: 0 }, 3)).toBe("the exchange and a pawn");
    expect(materialEdgePhrase({ p: 2, b: -1, r: 1, q: 0 }, 4)).toBe("the exchange and pawns");
    expect(materialEdgePhrase({ p: -1, b: -1, r: 1, q: 0 }, 1)).toBe("the exchange for a pawn");
  });

  it("falls back to the magnitude phrase for non-exchange shapes", () => {
    expect(materialEdgePhrase({ p: 2, n: 0, b: 0, r: 0, q: 0 }, 2)).toBe("two pawns");
    expect(materialEdgePhrase(null, 2)).toBe("two pawns");
    // A queen-level edge is not "the exchange" even with a rook/minor swap riding along.
    expect(materialEdgePhrase({ q: 1, r: 1, b: -1 }, 11)).toBe("decisive material");
  });
});

describe("materialSwingPhrase (composition-aware line losses)", () => {
  it("names a knight-for-pawn loss instead of flattening it to two pawns", () => {
    expect(materialSwingPhrase({ p: 1, n: -1, b: 0, r: 0, q: 0 }, -2)).toBe("a knight for a pawn");
  });

  it("names a rook-for-knight loss as an exchange shape, not two pawns", () => {
    expect(materialSwingPhrase({ p: 0, n: 1, b: 0, r: -1, q: 0 }, -2)).toBe("a rook for a minor");
  });

  it("still uses pawn counts for plain pawn losses", () => {
    expect(materialSwingPhrase({ p: -2, n: 0, b: 0, r: 0, q: 0 }, -2)).toBe("two pawns");
  });
});

describe("squareExchangeBoard (settled board for composition)", () => {
  it("resolves the recapture so the composition reads 'up the exchange'", () => {
    // Black has just played Bxa1, snapping a rook; White recaptures Qxa1. Once it settles,
    // Black is up a rook for a bishop — the exchange — with the queens still on.
    const afterBxa1 = "1r4kr/4q3/3b4/8/8/8/8/bQB2BKR w - - 0 1";
    const settled = squareExchangeBoard(new Chess(afterBxa1), "a1");
    const diff = perPieceDiff(settled); // White-POV
    expect(diff.r).toBe(-1); // White is down a rook
    expect(diff.b).toBe(1); //  ...but up a bishop
    expect(diff.q).toBe(0); // queens level — White's recaptured
    const moverDiff = { p: -diff.p, n: -diff.n, b: -diff.b, r: -diff.r, q: -diff.q };
    expect(materialEdgePhrase(moverDiff, 2)).toBe("the exchange");
  });

  it("leaves a quiet (non-capture) position untouched", () => {
    const settled = squareExchangeBoard(new Chess(START), "e4");
    expect(perPieceDiff(settled)).toEqual({ p: 0, n: 0, b: 0, r: 0, q: 0 });
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

  it("keeps the settled composition of a knight-for-pawn sequence", () => {
    const fen = "8/8/4k3/5p2/3N4/8/8/6K1 w - - 0 1";
    const line = walkLine(fen, ["d4f5", "e6f5"]);
    expect(line.settledSwing).toBe(-2);
    expect(line.settledDiffSwing).toMatchObject({ p: 1, n: -1 });
    expect(materialSwingPhrase(line.settledDiffSwing, line.settledSwing)).toBe("a knight for a pawn");
  });
});

describe("gamePhase (lichess/scalachess Divider port)", () => {
  it("calls the start an opening and a bare-pieces position an endgame", () => {
    expect(gamePhase(START)).toBe("opening");
    expect(gamePhase("4k3/8/8/8/8/8/4P3/4K3 w - - 0 40")).toBe("endgame");
  });

  it("calls a position with <= 6 majors+minors an endgame regardless of move number", () => {
    // Each side has only R+R+N (3 non-K/P pieces) -> majorsAndMinors = 6 -> endgame.
    expect(gamePhase("r3k1nr/pppppppp/8/8/8/8/PPPPPPPP/R3K1NR w - - 0 5")).toBe("endgame");
  });

  it("calls a reduced (<= 10 majors+minors) position a middlegame", () => {
    // 4 non-K/P pieces per side -> majorsAndMinors = 8 -> middlegame even with full pawns.
    expect(gamePhase("rnbqk3/pppppppp/8/8/8/8/PPPPPPPP/RNBQK3 w - - 0 8")).toBe("middlegame");
  });

  it("calls a back-rank-sparse position a middlegame (development under way)", () => {
    // White has only R(a1), R(f1), K(g1) left on the first rank (< 4) -> back-rank sparse
    // -> middlegame, even with a full complement of pieces still on the board.
    expect(gamePhase("r2q1rk1/pppbbppp/2n2n2/3pp3/3PP3/2NQBN2/PPP1BPPP/R4RK1 w - - 0 10"))
      .toBe("middlegame");
  });
});
