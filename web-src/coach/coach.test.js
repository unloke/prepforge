import { describe, it, expect } from "vitest";

import {
  buildMoveFeatures,
  isBrilliantByMaia,
  markBrilliant,
  BRILLIANT_MAX_HUMAN_PROB,
  BRILLIANT_MIN_WIN_GAP,
} from "./features.js";
import { buildCommentary } from "./commentary.js";

// A blunder that hangs a bishop: from a quiet K+B vs K+pawn position, White plays
// Bb5?? where the c6 pawn just takes it.
function hangingBishopInput() {
  const fenBefore = "6k1/8/2p5/8/8/8/8/5BK1 w - - 0 1";
  const fenAfter = "6k1/8/2p5/1B6/8/8/8/6K1 b - - 1 1";
  return {
    ply: 1,
    moveNumber: 1,
    mover: "white",
    uci: "f1b5",
    san: "Bb5",
    fenBefore,
    fenAfter,
    beforeEval: {
      lines: [
        { uci: "g1f2", san: "Kf2", cp: 0, mate: null, pvUci: ["g1f2"] },
        { uci: "g1g2", san: "Kg2", cp: -10, mate: null, pvUci: ["g1g2"] },
      ],
    },
    afterEval: { cp: -300, mate: null, pvUci: ["c6b5"] },
  };
}

describe("buildMoveFeatures", () => {
  it("derives win%, accuracy and classification from the evals", () => {
    const f = buildMoveFeatures(hangingBishopInput());
    expect(Math.round(f.winBeforeMover)).toBe(50);
    expect(f.winAfterMover).toBeLessThan(35);
    expect(f.winDelta).toBeGreaterThan(15);
    expect(f.accuracy).toBeLessThan(40);
    expect(f.classification.code).toBe("blunder");
    expect(f.isBest).toBe(false);
  });

  it("spots the bishop it left hanging", () => {
    const f = buildMoveFeatures(hangingBishopInput());
    expect(f.hangingOwnTop).toMatchObject({ square: "b5", type: "b" });
  });

  it("grades the engine's own top move as Best", () => {
    const inp = hangingBishopInput();
    // Pretend White played the recommended Kf2 instead.
    inp.uci = "g1f2";
    inp.san = "Kf2";
    inp.fenAfter = "6k1/8/2p5/8/8/8/5K2/5B2 b - - 1 1";
    inp.afterEval = { cp: 0, mate: null, pvUci: [] };
    const f = buildMoveFeatures(inp);
    expect(f.isBest).toBe(true);
    expect(["best", "great"]).toContain(f.classification.code);
  });

  it("reads a check and a forced reply", () => {
    // Black king in check from a rook on e8; the only legal move is Kxe8-ish escape.
    const fenBefore = "4R1k1/6pp/8/8/8/8/8/6K1 b - - 0 1";
    const fenAfter = "6k1/6pp/8/8/8/8/8/6K1 w - - 0 2"; // Kxe8 not possible; illustrative
    const f = buildMoveFeatures({
      mover: "black",
      uci: "g8f8",
      san: "Kf8",
      fenBefore,
      fenAfter,
      beforeEval: { lines: [{ uci: "g8f8", san: "Kf8", cp: -900, mate: null, pvUci: ["g8f8"] }] },
      afterEval: { cp: -900, mate: null, pvUci: [] },
    });
    expect(f.wasInCheck).toBe(true);
  });

  it("flags a forced mate that was missed", () => {
    const fenBefore = "6k1/5ppp/8/8/8/8/5PPP/4Q1K1 w - - 0 1";
    const fenAfter = "6k1/5ppp/8/8/8/8/5PPP/5QK1 b - - 1 1";
    const f = buildMoveFeatures({
      mover: "white",
      uci: "e1f1",
      san: "Qf1",
      fenBefore,
      fenAfter,
      beforeEval: { lines: [{ uci: "e1e8", san: "Qe8#", cp: null, mate: 1, pvUci: ["e1e8"] }] },
      afterEval: { cp: 50, mate: null, pvUci: [] },
    });
    expect(f.hadMateBefore).toBe(true);
    expect(f.missedMate).toBe(true);
  });
});

describe("buildCommentary (prose)", () => {
  it("calls a hanging blunder what it is and names the better move — in one sentence", () => {
    const f = buildMoveFeatures(hangingBishopInput());
    const c = buildCommentary(f);
    expect(c.grade).toBe("Blunder");
    expect(c.tone).toBe("danger");
    expect(c.prose).toMatch(/blunder/i);
    expect(c.prose).toMatch(/bishop on b5/i);
    expect(c.prose).toMatch(/Kf2/); // the move to play instead
    expect(c.prose).toMatch(/saving a piece/); // rescues, not "wins"
    // No data dump: no "Accuracy", no percentages.
    expect(c.prose).not.toMatch(/Accuracy/i);
    expect(c.prose).not.toMatch(/%/);
  });

  it("praises the engine's own move warmly", () => {
    const inp = hangingBishopInput();
    inp.uci = "g1f2";
    inp.san = "Kf2";
    inp.fenAfter = "6k1/8/2p5/8/8/8/5K2/5B2 b - - 1 1";
    inp.afterEval = { cp: 0, mate: null, pvUci: [] };
    const c = buildCommentary(buildMoveFeatures(inp));
    expect(c.tone).toBe("good");
    expect(c.prose).toMatch(/Kf2/);
    expect(c.prose).not.toMatch(/%/);
  });

  it("reads the same move the same way every time (deterministic voice)", () => {
    const f = buildMoveFeatures(hangingBishopInput());
    expect(buildCommentary(f).prose).toBe(buildCommentary(f).prose);
  });

  it("a quiet mistake without a hanging piece still names the move and the fix", () => {
    const fenBefore = "6k1/8/2p5/8/8/8/8/5BK1 w - - 0 1";
    const f = buildMoveFeatures({
      mover: "white",
      uci: "g1g2",
      san: "Kg2",
      fenBefore,
      fenAfter: "6k1/8/2p5/8/8/8/6K1/5B2 b - - 1 1",
      beforeEval: { lines: [{ uci: "f1e2", san: "Be2", cp: 100, mate: null, pvUci: ["f1e2"] }] },
      afterEval: { cp: -100, mate: null, pvUci: [] },
    });
    expect(f.classification.code).toBe("mistake");
    expect(f.hangingOwnTop).toBeNull();
    const c = buildCommentary(f);
    expect(c.prose).toMatch(/Kg2/);
    expect(c.prose).toMatch(/Be2/);
  });

  it("an inaccuracy that actually flips the evaluation says so", () => {
    const fenBefore = "6k1/8/2p5/8/8/8/8/5BK1 w - - 0 1";
    const f = buildMoveFeatures({
      mover: "white",
      uci: "g1f2",
      san: "Kf2",
      fenBefore,
      fenAfter: "6k1/8/2p5/8/8/8/5K2/5B2 b - - 1 1",
      beforeEval: { lines: [{ uci: "g1g2", san: "Kg2", cp: 100, mate: null, pvUci: ["g1g2"] }] },
      afterEval: { cp: -4, mate: null, pvUci: [] },
    });
    expect(f.classification.code).toBe("inaccuracy");
    expect(f.winAfterMover).toBeLessThan(50);
    const c = buildCommentary(f);
    expect(c.prose).toMatch(/edges ahead/i);
  });

  it("calls out a forced mate the move just delivered", () => {
    const inp = hangingBishopInput();
    inp.uci = "g1f2";
    inp.san = "Kf2";
    inp.fenAfter = "6k1/8/2p5/8/8/8/5K2/5B2 b - - 1 1";
    inp.afterEval = { cp: null, mate: 2, pvUci: [] };
    const f = buildMoveFeatures(inp);
    expect(f.hasMateAfter).toBe(true);
    const c = buildCommentary(f);
    expect(c.prose).toMatch(/mate in 2/i);
  });

  it("names the punishing reply and the material it wins, from the played line", () => {
    // White's Kd1 hangs nothing outright, but a rook mops up two pawns by force.
    const f = buildMoveFeatures({
      ply: 11,
      moveNumber: 6,
      mover: "white",
      uci: "e1d1",
      san: "Kd1",
      fenBefore: "r3k3/8/8/8/8/8/P5P1/4K3 w - - 0 1",
      fenAfter: "r3k3/8/8/8/8/8/P5P1/3K4 b - - 1 1",
      beforeEval: {
        lines: [
          { uci: "a2a4", san: "a4", cp: 180, mate: null, pvUci: ["a2a4"], pvSan: ["a4"] },
          { uci: "g2g4", san: "g4", cp: 150, mate: null, pvUci: ["g2g4"], pvSan: ["g4"] },
        ],
      },
      afterEval: { cp: -150, mate: null, pvUci: ["a8a2", "d1e1", "a2g2"], pvSan: ["Rxa2", "Ke1", "Rxg2"] },
    });
    // No PIECE hangs (only a pawn) — so the prose takes the forcing-line path, not the
    // "drops the bishop"-style hang branch (which gates on worth >= 3).
    expect(f.hangingOwnTop.worth).toBeLessThan(3);
    const c = buildCommentary(f);
    expect(c.prose).toMatch(/Rxa2/); // the punishing reply, named
    expect(c.prose).toMatch(/two pawns/); // the count, from the line's material swing
    expect(c.prose).toMatch(/a4/); // the fix
    expect(c.prose).toMatch(/saving two pawns/);
    expect(c.prose).not.toMatch(/%/);
  });

  it("recommends the better move with a positional merit when there's no material to save", () => {
    // A quiet mistake (no piece hangs, no material swings) — the fix is named with the
    // standing it keeps, not a pawn count.
    const f = buildMoveFeatures({
      mover: "white",
      uci: "g1g2",
      san: "Kg2",
      fenBefore: "6k1/8/2p5/8/8/8/8/5BK1 w - - 0 1",
      fenAfter: "6k1/8/2p5/8/8/8/6K1/5B2 b - - 1 1",
      beforeEval: { lines: [{ uci: "f1e2", san: "Be2", cp: 120, mate: null, pvUci: ["f1e2"], pvSan: ["Be2"] }] },
      afterEval: { cp: -100, mate: null, pvUci: [] },
    });
    expect(f.classification.code).toBe("mistake");
    const c = buildCommentary(f);
    expect(c.prose).toMatch(/Be2/);
    expect(c.prose).toMatch(/keeping White|holding the balance|in the game|limiting the damage/);
    expect(c.prose).not.toMatch(/%/);
  });

  it("spells out the fork a strong move creates", () => {
    // White knight e6 lands on c7, forking the king on e8 and the rook on a8.
    const f = buildMoveFeatures({
      moveNumber: 12,
      mover: "white",
      uci: "e6c7",
      san: "Nc7+",
      fenBefore: "r3k3/8/4N3/8/8/8/6K1/8 w - - 0 1",
      fenAfter: "r3k3/2N5/8/8/8/8/6K1/8 b - - 1 1",
      beforeEval: {
        lines: [
          { uci: "e6c7", san: "Nc7+", cp: 300, mate: null, pvUci: ["e6c7"], pvSan: ["Nc7+"] },
          { uci: "g2g3", san: "Kg3", cp: 20, mate: null, pvUci: ["g2g3"], pvSan: ["Kg3"] },
        ],
      },
      afterEval: { cp: 300, mate: null, pvUci: [] },
    });
    const c = buildCommentary(f);
    expect(c.prose).toMatch(/fork/i);
    expect(c.prose).toMatch(/king/);
    expect(c.prose).toMatch(/rook/);
    expect(c.prose).not.toMatch(/—/);
  });

  it("spells out the pin a strong move creates", () => {
    // Bishop to g5 pins the f6 knight to the d8 queen.
    const f = buildMoveFeatures({
      moveNumber: 8,
      mover: "white",
      uci: "h4g5",
      san: "Bg5",
      fenBefore: "3q2k1/8/5n2/7B/8/8/6K1/8 w - - 0 1",
      fenAfter: "3q2k1/8/5n2/6B1/8/8/6K1/8 b - - 1 1",
      beforeEval: {
        lines: [
          { uci: "h4g5", san: "Bg5", cp: 80, mate: null, pvUci: ["h4g5"], pvSan: ["Bg5"] },
          { uci: "g2g3", san: "Kg3", cp: 10, mate: null, pvUci: ["g2g3"], pvSan: ["Kg3"] },
        ],
      },
      afterEval: { cp: 80, mate: null, pvUci: [] },
    });
    const c = buildCommentary(f);
    expect(c.prose).toMatch(/pin/i);
    expect(c.prose).toMatch(/knight/);
    expect(c.prose).toMatch(/queen/);
  });

  it("never uses an em-dash anywhere in its prose", () => {
    // House style: em-dashes read as machine-written. Sweep every branch.
    const inputs = [
      hangingBishopInput(),
      {
        mover: "white", uci: "g1g2", san: "Kg2",
        fenBefore: "6k1/8/2p5/8/8/8/8/5BK1 w - - 0 1",
        fenAfter: "6k1/8/2p5/8/8/8/6K1/5B2 b - - 1 1",
        beforeEval: { lines: [{ uci: "f1e2", san: "Be2", cp: 120, mate: null, pvUci: ["f1e2"] }] },
        afterEval: { cp: -100, mate: null, pvUci: [] },
      },
    ];
    for (const inp of inputs) {
      for (let ply = 0; ply < 40; ply++) {
        const prose = buildCommentary(buildMoveFeatures({ ...inp, ply })).prose;
        expect(prose).not.toMatch(/—|--/);
      }
    }
  });

  it("varies its wording widely across positions while staying grammatical", () => {
    const seen = new Set();
    for (let ply = 0; ply < 80; ply++) {
      const inp = hangingBishopInput();
      inp.ply = ply;
      const c = buildCommentary(buildMoveFeatures(inp));
      // No leftover template placeholders, no double spaces/punctuation.
      expect(c.prose).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(c.prose).not.toMatch(/  /);
      expect(c.prose).not.toMatch(/[ ,]\./);
      expect(c.prose).toMatch(/^[A-Z]/);
      expect(c.prose).toMatch(/[.!]$/);
      seen.add(c.prose);
    }
    // Same fact pattern, many distinct phrasings — the phrase-bank composition at work.
    expect(seen.size).toBeGreaterThan(30);
  });

  it("flags a missed mate conversationally", () => {
    const fenBefore = "6k1/5ppp/8/8/8/8/5PPP/4Q1K1 w - - 0 1";
    const fenAfter = "6k1/5ppp/8/8/8/8/5PPP/5QK1 b - - 1 1";
    const f = buildMoveFeatures({
      mover: "white",
      uci: "e1f1",
      san: "Qf1",
      fenBefore,
      fenAfter,
      beforeEval: { lines: [{ uci: "e1e8", san: "Qe8#", cp: null, mate: 1, pvUci: ["e1e8"] }] },
      afterEval: { cp: 50, mate: null, pvUci: [] },
    });
    const c = buildCommentary(f);
    expect(c.prose).toMatch(/mate/i);
    expect(c.prose).toMatch(/Qe8#/);
  });
});

describe("Brilliant detection (Maia vs engine, no SEE)", () => {
  // Kf2 here stands in for "engine's best, keeps the side on top" — a brilliant
  // CANDIDATE. The Maia numbers (synthetic) decide brilliancy, not any sacrifice test.
  function bestMoveFeatures() {
    const inp = hangingBishopInput();
    inp.uci = "g1f2";
    inp.san = "Kf2";
    inp.fenAfter = "6k1/8/2p5/8/8/8/5K2/5B2 b - - 1 1";
    inp.afterEval = { cp: 0, mate: null, pvUci: [] };
    return buildMoveFeatures(inp);
  }

  it("marks the move a candidate when the engine has it best and on top", () => {
    expect(bestMoveFeatures().brilliantCandidate).toBe(true);
    expect(buildMoveFeatures(hangingBishopInput()).brilliantCandidate).toBe(false); // a blunder
  });

  it("is brilliant when humans wouldn't play it and Maia rates it far worse", () => {
    const f = bestMoveFeatures();
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.02, maiaWinAfter: 0.2 })).toBe(true);
  });

  it("is NOT brilliant when humans would happily play it", () => {
    const f = bestMoveFeatures();
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.55, maiaWinAfter: 0.2 })).toBe(false);
  });

  it("is NOT brilliant when Maia agrees the move is strong", () => {
    const f = bestMoveFeatures();
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.03, maiaWinAfter: 0.52 })).toBe(false);
  });

  it("honours the win-gap threshold exactly (engine win% over Maia win%)", () => {
    const f = bestMoveFeatures(); // engine win% after = 50 (cp 0), mover POV
    expect(f.winAfterMover).toBe(50);
    // gap = 50 - maiaWin%. The threshold is BRILLIANT_MIN_WIN_GAP points.
    const atThreshold = (50 - BRILLIANT_MIN_WIN_GAP) / 100; // gap == threshold → brilliant
    const justUnder = (50 - (BRILLIANT_MIN_WIN_GAP - 1)) / 100; // gap one short → not
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.02, maiaWinAfter: atThreshold })).toBe(true);
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.02, maiaWinAfter: justUnder })).toBe(false);
  });

  it("requires humans to almost never play it (probability cap)", () => {
    const f = bestMoveFeatures();
    const overCap = BRILLIANT_MAX_HUMAN_PROB + 0.001;
    expect(isBrilliantByMaia(f, { maiaHumanProb: overCap, maiaWinAfter: 0.2 })).toBe(false);
    expect(isBrilliantByMaia(f, { maiaHumanProb: BRILLIANT_MAX_HUMAN_PROB, maiaWinAfter: 0.2 })).toBe(true);
  });

  it("upgrades the prose to a brilliancy once confirmed", () => {
    const f = bestMoveFeatures();
    markBrilliant(f, { humanProb: 0.02, winChanceAfter: 0.2 });
    const c = buildCommentary(f);
    expect(c.tone).toBe("brilliant");
    expect(c.prose).toMatch(/Brilliant/);
  });

  it("grounds the brilliancy in the Maia numbers — rarity and the disagreement", () => {
    const f = bestMoveFeatures();
    markBrilliant(f, { humanProb: 0.02, winChanceAfter: 0.2 });
    const c = buildCommentary(f);
    expect(c.prose).toMatch(/players/i);
    expect(c.prose).toMatch(/Stockfish/);
  });

  it("a near-best (Excellent-tier) move is a brilliant candidate too, not just the literal #1", () => {
    const fenBefore = "6k1/8/2p5/8/8/8/8/5BK1 w - - 0 1";
    const f = buildMoveFeatures({
      mover: "white",
      uci: "g1f2",
      san: "Kf2",
      fenBefore,
      fenAfter: "6k1/8/2p5/8/8/8/5K2/5B2 b - - 1 1",
      beforeEval: { lines: [{ uci: "g1g2", san: "Kg2", cp: 100, mate: null, pvUci: ["g1g2"] }] },
      afterEval: { cp: 56, mate: null, pvUci: [] },
    });
    expect(f.isBest).toBe(false);
    expect(f.classification.code).toBe("good");
    expect(f.winDelta).toBeGreaterThan(2);
    expect(f.winDelta).toBeLessThanOrEqual(5);
    expect(f.brilliantCandidate).toBe(true);
  });
});
