import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import {
  backrankSparse,
  boardSnapshot,
  CRITICAL_THRESHOLD,
  divideGame,
  explorerBonus,
  extractLocalFeatures,
  isCritical,
  majorsAndMinors,
  mixedness,
  phaseAt,
  phaseOf,
  pickKeyIndex,
  regionScore,
  scorePosition,
} from "./train-lucky-crit.js";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const SICILIAN = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
// Bare-kings endgame: K+P vs K, White to move.
const ENDGAME = "8/8/8/3k4/8/3K4/3P4/8 w - - 0 1";

describe("extractLocalFeatures", () => {
  it("counts material and legal moves on the start", () => {
    const f = extractLocalFeatures(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      0,
    );
    expect(f.nLegal).toBe(20);
    expect(f.nPieces).toBe(32);
    expect(f.matDiff).toBe(0);
    expect(f.queensOff).toBe(false);
    expect(f.inCheck).toBe(false);
  });

  it("spots checks, captures and pawn breaks in a tactic", () => {
    // White: Qh5+, Nxe5 threat shape — use a known sharp line instead.
    const f = extractLocalFeatures(
      "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1",
      8,
    );
    expect(f.nChecks + f.nCaptures).toBeGreaterThan(0);
    expect(f.ply).toBe(8);
  });

  it("never throws on hanging-piece probes", () => {
    expect(() => extractLocalFeatures(SICILIAN, 3)).not.toThrow();
  });
});

describe("phaseOf (material-only fallback)", () => {
  it("calls full armies opening", () => {
    expect(phaseOf({ nPieces: 32, nonPawnMat: 62 })).toBe("opening");
  });

  it("calls depleted boards endgame", () => {
    expect(phaseOf({ nPieces: 12, nonPawnMat: 10 })).toBe("endgame");
    expect(phaseOf({ nPieces: 18, nonPawnMat: 20 })).toBe("endgame");
  });

  it("calls the rest middlegame", () => {
    expect(phaseOf({ nPieces: 24, nonPawnMat: 40 })).toBe("middlegame");
  });
});

describe("lichess Divider port", () => {
  function playSans(sans) {
    const chess = new Chess();
    const boards = [boardSnapshot(chess.fen())];
    for (const san of sans) {
      chess.move(san);
      boards.push(boardSnapshot(chess.fen()));
    }
    return boards;
  }

  it("counts queens, rooks, bishops and knights of both sides", () => {
    expect(majorsAndMinors(boardSnapshot(AFTER_E4))).toBe(14);
    expect(majorsAndMinors(boardSnapshot(ENDGAME))).toBe(0);
  });

  it("spots an undeveloped vs developed back rank", () => {
    expect(
      backrankSparse(
        boardSnapshot("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"),
      ),
    ).toBe(false);
    // Black's back rank is down to R+K (5rk1): the army has left home.
    expect(
      backrankSparse(
        boardSnapshot("5rk1/4bpp1/p4n1p/2p1p3/1pP1b2B/7P/PP3PP1/RN1B2K1 w - - 0 21"),
      ),
    ).toBe(true);
  });

  it("matches the Scala region scores on spot checks", () => {
    expect(regionScore(1, 0, 1)).toBe(2);
    expect(regionScore(4, 1, 1)).toBe(5);
    expect(regionScore(3, 2, 2)).toBe(7);
    expect(regionScore(7, 0, 4)).toBe(0);
  });

  it("scores home armies near zero mixedness", () => {
    expect(mixedness(boardSnapshot(AFTER_E4))).toBeLessThan(150);
  });

  it("divides a Ruy Lopez: long opening, middlegame, late endgame", () => {
    const boards = playSans(
      "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 c4 c6 Nc3 Bb7 Bg5 b4 Nb1 h6 Bh4 c5 dxe5 Nxe5 Nxe5 dxe5 Qxd8 Raxd8 Rd1 Rxd1+ Bxd1 Bxe4 Bxf6 Bxf6 a4 Rb8 a5 Rb7 b3 Rb6 axb6 Bxb1 Rxb1 a5 b7 a4 b8=R Bd8 Rbxd8".split(
        " ",
      ),
    );
    const division = divideGame(boards);
    expect(division.middle).not.toBeNull();
    expect(division.end).not.toBeNull();
    expect(division.middle).toBeLessThan(division.end);
    expect(phaseAt(0, division)).toBe("opening");
    expect(phaseAt(division.middle, division)).toBe("middlegame");
    expect(phaseAt(division.end, division)).toBe("endgame");
  });

  it("never declares an endgame without a middlegame, and tolerates empties", () => {
    expect(divideGame([])).toEqual({ middle: null, end: null });
    expect(phaseAt(10, { middle: null, end: null })).toBe("opening");
    const boards = playSans(["e4", "e5", "Nf3", "Nc6"]);
    const division = divideGame(boards);
    if (division.end !== null) expect(division.middle).not.toBeNull();
  });
});

describe("explorerBonus", () => {
  it("rewards a wide low-consensus fork node", () => {
    expect(
      explorerBonus({
        totalGames: 2000,
        moves: [
          { uci: "e2e4", share: 0.3 },
          { uci: "d2d4", share: 0.3 },
          { uci: "c2c4", share: 0.25 },
          { uci: "g1f3", share: 0.15 },
        ],
      }),
    ).toBe(2);
  });

  it("gives a smaller bonus for a normal book node, none for thin samples", () => {
    expect(
      explorerBonus({ totalGames: 500, moves: [{ share: 0.9 }, { share: 0.1 }] }),
    ).toBe(1);
    expect(explorerBonus({ totalGames: 5, moves: [{ share: 1 }] })).toBe(0);
    expect(explorerBonus({ totalGames: 500, moves: [] })).toBe(0);
  });
});

describe("scorePosition", () => {
  it("ranks a sharp middlegame above a quiet opening ply", () => {
    const quiet = scorePosition(extractLocalFeatures(AFTER_E4, 1));
    const sharp = scorePosition(
      extractLocalFeatures(
        "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1",
        8,
      ),
    );
    expect(sharp).toBeGreaterThan(quiet);
  });

  it("adds the human-engine disagreement bonus", () => {
    const f = extractLocalFeatures(SICILIAN, 3);
    const agree = scorePosition(f, { maiaTop: "e2e4", engineBest: "e2e4" });
    const disagree = scorePosition(f, { maiaTop: "g1f3", engineBest: "e2e4" });
    expect(disagree - agree).toBeCloseTo(2.5, 5);
  });

  it("adds eval-swing evidence up to a cap", () => {
    const f = extractLocalFeatures(SICILIAN, 3);
    const base = scorePosition(f);
    expect(scorePosition(f, { swingPawns: 1 })).toBeCloseTo(base + 1.2, 5);
    expect(scorePosition(f, { swingPawns: 99 })).toBeCloseTo(base + 3, 5);
  });

  it("detects the endgame fixture as endgame and scores it quietly", () => {
    const f = extractLocalFeatures(ENDGAME, 80);
    expect(phaseOf(f)).toBe("endgame");
    expect(isCritical(f, {}, CRITICAL_THRESHOLD)).toBe(false);
  });
});

describe("pickKeyIndex", () => {
  it("picks among near-best elites with rng, honouring excludes", () => {
    const scores = [
      { index: 0, score: 7 },
      { index: 1, score: 6.8 },
      { index: 2, score: 2 },
    ];
    expect(pickKeyIndex(scores, { rng: () => 0 })).toBe(0);
    expect(pickKeyIndex(scores, { rng: () => 0.99 })).toBe(1);
    expect(pickKeyIndex(scores, { rng: () => 0, exclude: new Set([0, 1]) })).toBe(2);
  });

  it("returns -1 for an empty pool", () => {
    expect(pickKeyIndex([])).toBe(-1);
  });
});
