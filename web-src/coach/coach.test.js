import { describe, it, expect } from "vitest";

import {
  buildMoveFeatures,
  isBrilliantByMaia,
  markBrilliant,
  BRILLIANT_MAX_HUMAN_PROB,
  BRILLIANT_MIN_WIN_GAP,
  BRILLIANT_MIN_TRAP_GAP,
} from "./features.js";

// A passing trap_gap (well over the 0.05 bar) for the brilliant tests that isolate the
// other layers — the natural human move throws away ~half a win chance.
const TRAP_OK = 0.5;
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



describe("forced moves (only one legal move)", () => {
  // Black: Kh8, pawn h7. White: Ra8 (checks along the 8th rank), Kc1. The 8th rank is
  // covered and h7 is blocked by Black's own pawn, so Kg7 is the ONE legal move — nothing
  // to "find".
  function forcedCheckInput() {
    const fenBefore = "R6k/7p/8/8/8/8/8/2K5 b - - 0 1";
    const fenAfter = "R7/6kp/8/8/8/8/8/2K5 w - - 1 2";
    return {
      mover: "black",
      uci: "h8g7",
      san: "Kg7",
      fenBefore,
      fenAfter,
      beforeEval: { lines: [{ uci: "h8g7", san: "Kg7", cp: 600, mate: null, pvUci: ["h8g7"], pvSan: ["Kg7"] }] },
      afterEval: { cp: 600, mate: null, pvUci: [] },
    };
  }

  it("classifies a single-legal-move position as forced, not great", () => {
    const f = buildMoveFeatures(forcedCheckInput());
    expect(f.forced).toBe(true);
    expect(f.onlyMove).toBe(false); // not a "find" — there was no choice
    expect(f.classification.code).toBe("forced");
  });

  it("says the move was forced rather than praising a find", () => {
    const c = buildCommentary(buildMoveFeatures(forcedCheckInput()));
    expect(c.tone).toBe("info");
    expect(c.prose).toMatch(/forced|only (legal )?move|no choice|only way|one way out|only legal/i);
    expect(c.prose).not.toMatch(/great|well spotted|well found|nicely found|found it/i);
    expect(c.prose).not.toMatch(/%/);
  });

  it("a genuine only-move with real alternatives is still a Great find, not forced", () => {
    // Plenty of legal moves, but only Be2 holds (the alternative hangs the bishop) — a
    // real choice the player had to get right. This stays Great, distinct from forced.
    const f = buildMoveFeatures({
      mover: "white",
      uci: "f1e2",
      san: "Be2",
      fenBefore: "6k1/8/2p5/8/8/8/8/5BK1 w - - 0 1",
      fenAfter: "6k1/8/2p5/8/8/8/4B3/6K1 b - - 1 1",
      beforeEval: {
        lines: [
          { uci: "f1e2", san: "Be2", cp: 80, mate: null, pvUci: ["f1e2"] },
          { uci: "f1b5", san: "Bb5", cp: -300, mate: null, pvUci: ["f1b5"] },
        ],
      },
      afterEval: { cp: 80, mate: null, pvUci: [] },
    });
    expect(f.forced).toBe(false);
    expect(f.onlyMove).toBe(true);
    expect(f.classification.code).toBe("great");
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
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.02, maiaWinAfter: 0.2, trapGap: TRAP_OK })).toBe(true);
  });

  it("is NOT brilliant when humans would happily play it", () => {
    const f = bestMoveFeatures();
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.55, maiaWinAfter: 0.2, trapGap: TRAP_OK })).toBe(false);
  });

  it("is NOT brilliant when Maia agrees the move is strong", () => {
    const f = bestMoveFeatures();
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.03, maiaWinAfter: 0.52, trapGap: TRAP_OK })).toBe(false);
  });

  it("is NOT brilliant when the natural move is not a trap (trap-gap layer)", () => {
    // Unintuitive + big reveal, but the move a human would naturally play is just as good:
    // trap_gap below the bar → finding this move didn't actually matter → not brilliant.
    const f = bestMoveFeatures();
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.02, maiaWinAfter: 0.2, trapGap: 0.01 })).toBe(false);
  });

  it("is NOT brilliant when the trap is un-evaluable (no trap value)", () => {
    // Maia had no policy / the natural move couldn't be evaluated → trapGap null → we can't
    // judge the trap layer, so the move is not flagged (fail closed, matching the server).
    const f = bestMoveFeatures();
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.02, maiaWinAfter: 0.2, trapGap: null })).toBe(false);
  });

  it("honours the win-gap threshold exactly (engine win% over Maia win%)", () => {
    const f = bestMoveFeatures(); // engine win% after = 50 (cp 0), mover POV
    expect(f.winAfterMover).toBe(50);
    // gap = 50 - maiaWin%. The threshold is BRILLIANT_MIN_WIN_GAP points.
    const atThreshold = (50 - BRILLIANT_MIN_WIN_GAP) / 100; // gap == threshold → brilliant
    const justUnder = (50 - (BRILLIANT_MIN_WIN_GAP - 1)) / 100; // gap one short → not
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.02, maiaWinAfter: atThreshold, trapGap: TRAP_OK })).toBe(true);
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.02, maiaWinAfter: justUnder, trapGap: TRAP_OK })).toBe(false);
  });

  it("honours the trap-gap threshold exactly", () => {
    const f = bestMoveFeatures();
    const justUnder = BRILLIANT_MIN_TRAP_GAP - 0.001; // one hair short → not
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.02, maiaWinAfter: 0.2, trapGap: BRILLIANT_MIN_TRAP_GAP })).toBe(true);
    expect(isBrilliantByMaia(f, { maiaHumanProb: 0.02, maiaWinAfter: 0.2, trapGap: justUnder })).toBe(false);
  });

  it("requires humans to almost never play it (probability cap)", () => {
    const f = bestMoveFeatures();
    const overCap = BRILLIANT_MAX_HUMAN_PROB + 0.001;
    expect(isBrilliantByMaia(f, { maiaHumanProb: overCap, maiaWinAfter: 0.2, trapGap: TRAP_OK })).toBe(false);
    expect(isBrilliantByMaia(f, { maiaHumanProb: BRILLIANT_MAX_HUMAN_PROB, maiaWinAfter: 0.2, trapGap: TRAP_OK })).toBe(true);
  });

  it("upgrades the prose to a brilliancy once confirmed", () => {
    const f = bestMoveFeatures();
    markBrilliant(f, { humanProb: 0.02, winChanceAfter: 0.2 });
    const c = buildCommentary(f);
    expect(c.tone).toBe("brilliant");
    expect(c.prose).toMatch(/Brilliant/);
  });

  it("grounds the brilliancy in the Maia numbers", () => {
    const f = bestMoveFeatures();
    markBrilliant(f, { humanProb: 0.02, winChanceAfter: 0.2 });
    expect(buildCommentary(f).prose).toMatch(/Only about 2% of players at this level would find it\.$/);
  });

  it("a near-best (Excellent-tier) move is a brilliant candidate too, not just the literal #1", () => {
    // winDelta <= 2 (the server's EXCELLENT band, win-chance loss <= excellent_loss 0.02)
    // but not the engine's literal #1 — still eligible to be queried, matching
    // services/brilliant.py. Label vs classification: the SERVER classifies such a
    // move EXCELLENT (classify_move only returns BEST on played === best_move_uci);
    // the FRONTEND's classifyMoveRich maps winDelta <= 2 to its display label "Best
    // move" (code "best") — the bands coincide, but they are different systems. The
    // eligibility gate mirrors the server's `BEST || EXCELLENT` either way.
    const fenBefore = "6k1/8/2p5/8/8/8/8/5BK1 w - - 0 1";
    const f = buildMoveFeatures({
      mover: "white",
      uci: "g1f2",
      san: "Kf2",
      fenBefore,
      fenAfter: "6k1/8/2p5/8/8/8/5K2/5B2 b - - 1 1",
      beforeEval: { lines: [{ uci: "g1g2", san: "Kg2", cp: 95, mate: null, pvUci: ["g1g2"] }] },
      afterEval: { cp: 74, mate: null, pvUci: [] },
    });
    expect(f.isBest).toBe(false);
    expect(f.winDelta).toBeGreaterThan(0);
    expect(f.winDelta).toBeLessThanOrEqual(2);
    expect(f.brilliantCandidate).toBe(true);
  });

  it("a Good-tier move beyond the Excellent band is NOT a candidate (aligned with analyze)", () => {
    // winDelta in (2, 5]: the browser classifier still calls this "good", but the server
    // classifies it GOOD (not EXCELLENT), so its full-game analysis would never consider
    // it brilliant. The coach must agree — the old winDelta <= 5 gate was the source of
    // moves flagged "Brilliant" live that the report never starred.
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
    expect(f.classification.code).toBe("good");
    expect(f.winDelta).toBeGreaterThan(2);
    expect(f.winDelta).toBeLessThanOrEqual(5);
    expect(f.brilliantCandidate).toBe(false);
  });

  it("the engine's best move stays a candidate even when before/after searches disagree by > the cap (BEST bypass)", () => {
    // isBest (played === best line), but the fenBefore best-line eval (cp 300) and the fenAfter
    // read (cp 0) disagree by > 2 win% pts — as two independent fixed-depth searches can on a
    // sharp line. The server returns BEST on played===best_move_uci regardless of loss, so the
    // coach must keep it a candidate too rather than drop a prime brilliancy before Maia.
    const fenBefore = "6k1/8/2p5/8/8/8/8/5BK1 w - - 0 1";
    const f = buildMoveFeatures({
      mover: "white",
      uci: "g1f2",
      san: "Kf2",
      fenBefore,
      fenAfter: "6k1/8/2p5/8/8/8/5K2/5B2 b - - 1 1",
      beforeEval: { lines: [{ uci: "g1f2", san: "Kf2", cp: 300, mate: null, pvUci: ["g1f2"] }] },
      afterEval: { cp: 0, mate: null, pvUci: [] },
    });
    expect(f.isBest).toBe(true);
    expect(f.winDelta).toBeGreaterThan(3);
    expect(f.brilliantCandidate).toBe(true);
  });
});
