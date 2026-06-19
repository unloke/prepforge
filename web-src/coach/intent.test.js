import { describe, it, expect } from "vitest";
import { Chess } from "chess.js";

import { detectIntent } from "./intent.js";

// Play `san` from `fen` and return { after, uci } so the tests read positions, not UCIs.
function play(fen, san) {
  const c = new Chess(fen);
  const m = c.move(san);
  return { after: c.fen(), uci: m.from + m.to + (m.promotion || "") };
}

function intentOf(fen, san, color) {
  const { after, uci } = play(fen, san);
  return detectIntent(fen, after, uci, san, color);
}

describe("intent — defend", () => {
  it("covers a piece the opponent could win", () => {
    // White Nd4 hangs to Bg7 on the long diagonal; Rd1 defends it.
    const i = intentOf("4k3/6b1/8/8/3N4/8/8/R3K3 w - - 0 1", "Rd1", "w");
    expect(i).toEqual({ kind: "defend", piece: "knight", sq: "d4", moved: false });
  });

  it("gets the threatened piece itself out of the firing line", () => {
    const i = intentOf("4k3/6b1/8/8/3N4/8/8/R3K3 w - - 0 1", "Nf5", "w");
    expect(i).toEqual({ kind: "defend", piece: "knight", sq: "d4", moved: true });
  });
});

describe("intent — open line", () => {
  it("frees the long diagonal for a fianchettoed bishop", () => {
    // Bg2's diagonal is blocked by the e4 pawn; e5 clears it onto the knight on c6.
    const i = intentOf("4k3/8/2n5/8/4P3/8/6B1/6K1 w - - 0 1", "e5", "w");
    expect(i).toEqual({ kind: "openLine", piece: "bishop", line: "the long diagonal" });
  });
});

describe("intent — prophylaxis", () => {
  it("removes a pin the opponent was threatening", () => {
    // Bg4 pins Nf3 to the Ke2; stepping the king off the diagonal kills the pin.
    const i = intentOf("4k3/8/8/8/6b1/5N2/4K3/8 w - - 0 1", "Kd3", "w");
    expect(i).toEqual({ kind: "prophylaxis", stopped: "pin" });
  });
});

describe("intent — trade", () => {
  it("offers an even swap of equal pieces", () => {
    // Nf5 attacks the king-defended Ne7; our knight is defended by the e4 pawn (an offer,
    // not a win). f5 is off-centre so this reads as the trade, not a centralisation.
    const i = intentOf("4k3/4n3/p7/8/4P3/6N1/8/4K3 w - - 0 1", "Nf5", "w");
    expect(i).toEqual({ kind: "trade", piece: "knight", ahead: false });
  });
});

describe("intent — centre", () => {
  it("names a knight planted on a central outpost", () => {
    // Nd4 sits in the centre, defended by the e3 pawn — a strong central post.
    const i = intentOf("6k1/1p6/2n5/8/8/4P3/4N3/6K1 w - - 0 1", "Nd4", "w");
    expect(i).toEqual({ kind: "center", piece: "knight", sq: "d4", knight: true });
  });
});

describe("intent — develop", () => {
  it("calls a quiet back-rank knight move development", () => {
    // 1.Nf3 — nothing tactical, but it brings a piece into the game.
    const i = intentOf("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "Nf3", "w");
    expect(i).toEqual({ kind: "develop", piece: "knight" });
  });

  it("calls a rook to an open file development", () => {
    // The c-file has no pawns → open; ...Rac8 swings the rook onto it (middlegame, plenty
    // of pieces left, so it isn't read as an endgame rook activation).
    const i = intentOf("r2q1rk1/pp2ppbp/2n2np1/3p1b2/3P1B2/1BN1PN2/PP3PPP/R2Q1RK1 b - - 2 10", "Rac8", "b");
    expect(i).toMatchObject({ kind: "develop", piece: "rook", file: "c", openFile: "open" });
  });
});

describe("intent — king attack", () => {
  it("flags a wing pawn storming the castled king", () => {
    const i = intentOf("6k1/5ppp/8/8/6P1/8/8/6K1 w - - 0 1", "g5", "w");
    expect(i).toEqual({ kind: "kingAttack", via: "pawn storm" });
  });

  it("does NOT call a quiet developing move a king attack", () => {
    // 1.Nf3 — kings are central, nothing threatened: it reads as development, not an attack.
    const i = intentOf("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "Nf3", "w");
    expect(i.kind).not.toBe("kingAttack");
  });
});
