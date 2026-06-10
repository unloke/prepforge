import { describe, it, expect } from "vitest";

import { buildMoveFeatures } from "./features.js";
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

describe("buildCommentary", () => {
  it("calls a hanging blunder what it is and points to the better move", () => {
    const f = buildMoveFeatures(hangingBishopInput());
    const c = buildCommentary(f);
    expect(c.verdict.label).toBe("Blunder");
    expect(c.headline).toMatch(/White/);
    expect(c.primary.tone).toBe("danger");
    expect(c.primary.text).toMatch(/bishop on b5/i);
    expect(c.primary.text).toMatch(/Kf2/); // the recommended move
    expect(c.notes.join(" ")).toMatch(/Accuracy/);
    // The better move RESCUES material — it should read "keeps", never "wins".
    const better = c.notes.find((n) => n.startsWith("Better:"));
    expect(better).toMatch(/saves a piece/);
    expect(better).not.toMatch(/wins/);
  });

  it("praises the engine's own move", () => {
    const inp = hangingBishopInput();
    inp.uci = "g1f2";
    inp.san = "Kf2";
    inp.fenAfter = "6k1/8/2p5/8/8/8/5K2/5B2 b - - 1 1";
    inp.afterEval = { cp: 0, mate: null, pvUci: [] };
    const c = buildCommentary(buildMoveFeatures(inp));
    expect(c.verdict.tone).toBe("good");
    expect(c.primary.tone).toBe("good");
  });

  it("flags a missed mate in the commentary", () => {
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
    expect(c.primary.text).toMatch(/mate/i);
    expect(c.primary.text).toMatch(/Qe8#/);
  });
});
