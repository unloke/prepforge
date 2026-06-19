// Regression tests pinned to the ACTUAL positions a user flagged in coach-review-ratings.json.
// Each asserts the chess.js-only layer (intent / move-narration / tactic) the review note was
// complaining about now reads correctly. These don't need an engine, so they run headlessly.
import { describe, it, expect } from "vitest";
import { Chess } from "chess.js";

import { detectIntent } from "./intent.js";
import { describeThreat, forkWinsMaterial } from "./tactics.js";
import { describeMove } from "../explain.js";

function play(fen, san) {
  const c = new Chess(fen);
  const m = c.move(san);
  return { after: c.fen(), uci: m.from + m.to + (m.promotion || "") };
}
function intentOf(fen, san, color) {
  const { after, uci } = play(fen, san);
  return detectIntent(fen, after, uci, san, color);
}

describe("review regressions — opening ideas now named", () => {
  it("...c5 challenges the centre pawn on d4", () => {
    const i = intentOf("rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1", "c5", "b");
    expect(i).toEqual({ kind: "centerStrike", sq: "d4" });
  });

  it("c3 reads as backing up the d4 centre pawn", () => {
    const d = describeMove("rnbqkbnr/pp1ppppp/8/2p5/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2", "c2c3", "c3");
    expect(d).toMatch(/backing up the centre pawn on d4/);
  });

  it("Nf6 is development", () => {
    const i = intentOf("rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1", "Nf6", "b");
    expect(i).toEqual({ kind: "develop", piece: "knight" });
  });

  it("...g6 prepares the fianchetto", () => {
    const i = intentOf("rnbqkb1r/pp1ppppp/5n2/2p5/3P1B2/2P5/PP2PPPP/RN1QKBNR b KQkq - 2 3", "g6", "b");
    expect(i).toEqual({ kind: "fianchettoPrep" });
  });

  it("...Bg7 completes the fianchetto", () => {
    const i = intentOf("rnbqkb1r/pp1ppp1p/5np1/2p5/3P1B2/2P1P3/PP3PPP/RN1QKBNR b KQkq - 0 4", "Bg7", "b");
    expect(i).toEqual({ kind: "fianchetto", sq: "g7" });
  });

  it("e3 opens the diagonal for the bishop, not the queen", () => {
    const i = intentOf("rnbqkb1r/pp1ppp1p/5np1/2p5/3P1B2/2P5/PP2PPPP/RN1QKBNR w KQkq - 0 4", "e3", "w");
    expect(i).toMatchObject({ kind: "openLine", piece: "bishop" });
  });
});

describe("review regressions — centralisation", () => {
  it("...Be4 centralises the bishop", () => {
    const i = intentOf("2rq1rk1/pp2ppbp/2n2np1/3p1b2/3P1B2/1BN1PN2/PP3PPP/2RQ1RK1 b - - 4 11", "Be4", "b");
    expect(i).toEqual({ kind: "center", piece: "bishop", sq: "e4", knight: false });
  });

  it("Ne5 plants the knight on a central outpost", () => {
    const i = intentOf("2rq1rk1/pp2ppbp/2n2np1/3p4/3PbB2/1BN1PN2/PP3PPP/2RQ1RK1 w - - 5 12", "Ne5", "w");
    expect(i).toEqual({ kind: "center", piece: "knight", sq: "e5", knight: true });
  });
});

describe("review regressions — no fake tactics", () => {
  it("Nxf4 is not described as a fork", () => {
    const d = describeMove("2rq1rk1/pp2ppbp/2n3p1/3pN2n/3PNB2/1B2P3/PP3PPP/2RQ1RK1 b - - 0 13", "h5f4", "Nxf4");
    expect(d).not.toMatch(/fork/i);
  });

  it("Rxc8 is not called a skewer (the queen just recaptures)", () => {
    const m = describeThreat("2Rq1rk1/pp2pp1p/4n1p1/3Nb3/8/1B2P3/PP3PPP/3Q1RK1 b - - 0 17", "c1c8", "w");
    expect(m === null || m.kind !== "skewer").toBe(true);
  });

  it("Qb4 is not called a skewer of a defended knight", () => {
    const m = describeThreat("r4rk1/1ppb1ppp/2n1pn2/p7/Pq1P4/2Q1PNP1/1P3PBP/R1R3K1 w - - 2 14", "b5b4", "b");
    expect(m === null || m.kind !== "skewer").toBe(true);
  });

  it("Ne5 is not a fork when one reply (Qe2) saves both targets", () => {
    const fen = "r2q1rk1/p2nppbp/3p1np1/2pP2B1/2B1P3/2N2Q1P/PP3PP1/R4RK1 b - - 2 12";
    const d = describeMove(fen, "d7e5", "Ne5");
    expect(d).not.toMatch(/forking/i);
    const { after, uci } = play(fen, "Ne5");
    const m = describeThreat(after, uci, "b");
    expect(m === null || m.kind !== "fork").toBe(true);
  });

  it("a genuine knight royal fork still reads as a fork (no over-suppression)", () => {
    // Nf6+ checks the king on g8 and wins the rook on e8 — the opponent can't save both.
    expect(forkWinsMaterial("4r1k1/8/5N2/8/8/8/8/6K1 b - - 0 1", "f6", "w")).toBe(true);
  });
});

describe("review regressions — round 3 (intent gaps + over-claims)", () => {
  it("d5 grabs central space (not 'opens the d-file for the queen')", () => {
    const i = intentOf("rnbqkbnr/pp1ppppp/8/2p5/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2", "d5", "w");
    expect(i.kind).toBe("space");
    expect(i.squares).toContain("c6");
    expect(i.squares).toContain("e6");
  });

  it("...Qb6 leans on the b2 base pawn", () => {
    const i = intentOf("r2q1rk1/3nppbp/b2p1np1/2pP4/8/2N2NP1/PP2PPBP/R1BQR1K1 b - - 7 11", "Qb6", "b");
    expect(i).toMatchObject({ kind: "pressure", sq: "b2", reinforce: false });
  });

  it("...Rfb8 reinforces the pressure on b2 (battery behind the queen)", () => {
    const i = intentOf("r4rk1/3nppbp/bq1p1np1/2pP4/8/2N2NP1/PPQ1PPBP/R1B1R1K1 b - - 9 12", "Rfb8", "b");
    expect(i).toMatchObject({ kind: "pressure", sq: "b2", file: "b", reinforce: true });
  });

  it("a rook seizing an open file is named even in the endgame", () => {
    const i = intentOf("6k1/8/8/8/8/8/5PPP/3R2K1 w - - 0 1", "Rd4", "w");
    expect(i).toMatchObject({ kind: "develop", piece: "rook", file: "d", openFile: "open" });
  });

  it("a pawn push that only frees the queen's line is NOT called an open line", () => {
    // b4 clears a1-f6 for the queen onto the knight; the queen is never credited an open line.
    const i = intentOf("4k3/8/5n2/8/8/8/1P6/Q3K3 w - - 0 1", "b4", "w");
    expect(i === null || i.kind !== "openLine").toBe(true);
  });

  it("Nxe5 doesn't 'eye' a follow-up — it's en prise and gets recaptured", () => {
    const d = describeMove("rr4k1/3nppbp/bq1p2p1/2pPn3/4P3/2N2NPP/PPQ2PB1/R1B1R1K1 w - - 1 15", "f3e5", "Nxe5");
    expect(d).not.toMatch(/eyes/i);
  });
});
