// Regression tests pinned to the ACTUAL positions a user flagged in coach-review-ratings.json.
// Each asserts the chess.js-only layer (intent / move-narration / tactic) the review note was
// complaining about now reads correctly. These don't need an engine, so they run headlessly.
import { describe, it, expect } from "vitest";
import { Chess } from "chess.js";

import { detectIntent } from "./intent.js";
import { describeThreat, forkWinsMaterial } from "./tactics.js";
import { describeMove } from "../explain.js";
import { buildCommentary } from "./commentary.js";

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

describe("review regressions — round 4 (false pressure / mislabelled moves)", () => {
  it("a king bearing on a DEFENDED bishop doesn't 'eye' it (king can't win it)", () => {
    // Kf3-g4 attacks the h4 bishop, but the g5 pawn defends it — Kxh4 is illegal. The old
    // cheap-attacker fallback (king worth 0) flagged it as winnable: the fake "eyes the h4 bishop".
    const d = describeMove("8/4k3/1p3p2/p4Pp1/P6b/5K1P/4B3/8 w - - 5 48", "f3g4", "Kg4");
    expect(d).not.toMatch(/eyes|bishop on h4/i);
  });

  it("a pawn advancing in front of its own rook doesn't 'open the file' (it re-blocks)", () => {
    // c4-c5 with a white rook on c3: the pawn still sits on the c-file, blocking the rook.
    const i = intentOf("6k1/5ppp/4p3/8/r1P5/2R1PP2/5P1P/6K1 w - - 0 31", "c5", "w");
    expect(i === null || i.kind !== "openLine").toBe(true);
  });

  it("a rook stepping off a slider's diagonal doesn't 'free' an empty diagonal", () => {
    // Rc6-c2 vacates Bf3's long diagonal, but it runs into empty space — nothing to bite.
    const i = intentOf("5rk1/p4p1p/1pR3p1/4b3/8/5B2/P4PKP/8 w - - 0 30", "Rc2", "w");
    expect(i === null || i.kind !== "openLine").toBe(true);
  });

  it("a rook already on an open file that slides along it isn't 'seizing' it", () => {
    // Ra4-a7: the rook was on the open a-file the whole time — repositioning, not development.
    const i = intentOf("6k1/5ppp/4p3/2P5/r7/2R1PP2/5P1P/6K1 b - - 0 31", "Ra7", "b");
    expect(i === null || i.kind !== "develop").toBe(true);
  });

  it("a central pawn push doesn't claim a square an enemy pawn occupies", () => {
    // f4-f5 controls e6 (empty) and attacks g6 (a black pawn). Space is only the empty square.
    const i = intentOf("8/6k1/1p3pp1/p1b4p/P3KP2/1B5P/8/8 w - - 2 43", "f5", "w");
    if (i && i.kind === "space") {
      expect(i.squares).not.toContain("g6");
      expect(i.squares).toContain("e6");
    }
  });

  it("a wing pawn push in a piece-endgame isn't a 'pawn storm' on the king", () => {
    // ...g7-g6 in a rook-and-minor endgame just gives the king luft — no castled king to storm.
    const i = intentOf("5rk1/5ppp/4p3/3n4/PpB5/1PrRPP2/5P1P/4R1K1 b - - 4 26", "g6", "b");
    expect(i === null || i.kind !== "kingAttack").toBe(true);
  });

  it("a knight pinned to the queen but shielded by a pawn isn't a real pin", () => {
    // ...Qh5 lines up on Nf3/Qe2, but the g2 pawn guards f3 — the pin bites nothing.
    const { after, uci } = play("2r2rk1/1b3ppp/p3pn2/1p1q4/8/1P1BPN2/P3QPPP/3RR1K1 b - - 6 20", "Qh5");
    const m = describeThreat(after, uci, "b");
    expect(m === null || m.kind !== "pin").toBe(true);
  });
});

// Minimal feature vector for buildCommentary tests (only fields the commentary path reads).
function makeFeatures(overrides = {}) {
  return {
    classification: { code: "inaccuracy", label: "Inaccuracy", glyph: "?!", tone: "warn" },
    mover: "black",
    san: "a6",
    uci: "a7a6",
    fenBefore: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
    fenAfter: "rnbqkbnr/1ppppppp/p7/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2",
    winBeforeMover: 50, winAfterMover: 45,
    winDelta: 5,
    bestSan: "Nf6", bestUci: "g8f6", isBest: false,
    altSan: null, altWinMover: null,
    replySan: null, replyUci: null,
    intuition: null, maia: null,
    phase: "opening",
    materialBefore: 0, materialAfter: 0, materialAfterSettled: 0, materialDiffAfter: null,
    hangingOwnTop: null, looseAfter: [], looseBefore: [], hangingOwn: [],
    missedMate: false, missedWin: false, hadMateBefore: false, hasMateAfter: false,
    inMateNet: false, wasInCheck: false, isCheck: false, forced: false, isForced: false, onlyMove: false,
    mateBefore: null, mateAfter: null,
    bestLine: null, altLine: null, playedLine: null,
    evalBeforeCp: 0, evalAfterCp: -15,
    brilliantCandidate: false,
    ply: 2, moveNumber: 1,
    ...overrides,
  };
}

describe("review regressions — best-move idea in prose", () => {
  it("inaccuracy prose adds developmental intent for best move Nf6", () => {
    const { prose } = buildCommentary(makeFeatures());
    // Nf6 as best → detectIntent → develop/knight → an intent phrase appended after INACC_CLEANER
    // The phrase may say "developing move", "knight joining", "brings the knight" etc.
    expect(prose).toMatch(/Nf6/);
    expect(prose).toMatch(/develop|knight.*join|join.*action|brings.*knight|knight.*play/i);
  });

  it("inaccuracy prose adds intent for best move d5 (opens line or grabs space)", () => {
    // Black played a6 (inaccuracy), best was d5
    const c = new Chess("rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1");
    c.move("a6");
    const { prose } = buildCommentary(makeFeatures({
      san: "a6", uci: "a7a6",
      fenBefore: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
      fenAfter: c.fen(),
      bestSan: "d5", bestUci: "d7d5",
    }));
    // d5 fires either openLine/bishop or space — either way the intent is named
    expect(prose).toMatch(/d5/);
    expect(prose).toMatch(/bishop|diagonal|space|squares|clamp|breathe/i);
  });

  it("inaccuracy prose mentions best move even when it has no detectable intent (no throw)", () => {
    // Best move is a6 — pure flank move; detectIntent returns null; prose should still name a6
    const c = new Chess("rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1");
    c.move("Nf6");
    const { prose } = buildCommentary(makeFeatures({
      san: "Nf6", uci: "g8f6",
      fenBefore: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
      fenAfter: c.fen(),
      bestSan: "a6", bestUci: "a7a6",
    }));
    expect(prose).toMatch(/a6/);
  });
});
