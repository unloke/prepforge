import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import {
  FEATURE_IDS,
  buildDecisionContext,
  decisionMeta,
  featureVector,
} from "./scout-bias-features.js";

function feat(vec, id) {
  const idx = FEATURE_IDS.indexOf(id);
  expect(idx).toBeGreaterThanOrEqual(0);
  return vec[idx];
}

function ctxAt(fen, opts = {}) {
  return buildDecisionContext(fen, opts);
}

function vecAt(fen, uci, opts = {}) {
  const ctx = ctxAt(fen, opts);
  return featureVector(ctx, uci);
}

function mirrorSquare(sq) {
  return sq[0] + (9 - Number(sq[1]));
}

function mirrorMove(uci) {
  return mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + (uci[4] || "");
}

function mirrorFen(fen) {
  const parts = fen.split(" ");
  const ranks = parts[0].split("/").reverse();
  const board = ranks
    .map((rank) =>
      rank
        .split("")
        .map((c) => {
          if (c >= "A" && c <= "Z") return c.toLowerCase();
          if (c >= "a" && c <= "z") return c.toUpperCase();
          return c;
        })
        .join(""),
    )
    .join("/");
  const turn = parts[1] === "w" ? "b" : "w";
  let castling = "-";
  if (parts[2] && parts[2] !== "-") {
    const map = { K: "k", Q: "q", k: "K", q: "Q" };
    castling = [...parts[2]].map((c) => map[c] || c).sort().join("") || "-";
  }
  let ep = "-";
  if (parts[3] && parts[3] !== "-") {
    ep = mirrorSquare(parts[3]);
  }
  return [board, turn, castling, ep, parts[4] || "0", parts[5] || "1"].join(" ");
}

describe("FEATURE_IDS", () => {
  it("has 26+ features in stable order", () => {
    expect(FEATURE_IDS.length).toBeGreaterThanOrEqual(26);
    expect(new Set(FEATURE_IDS).size).toBe(FEATURE_IDS.length);
  });
});

describe.each(FEATURE_IDS.map((id) => [id]))("feature %s", (id) => {
  const cases = {
    isCapture: { on: ["4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"], off: ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "g1f3"] },
    capturesPawn: { on: ["4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"], off: ["4k3/8/8/4n3/8/5N2/8/4K3 w - - 0 1", "f3d4"] },
    capturesUndefendedPawn: { on: ["4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"], off: ["4k3/8/3p4/4P3/8/5N2/8/4K3 w - - 0 1", "f3d4"] },
    capturesDefendedPiece: { on: ["4k3/8/3p4/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"], off: ["4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"] },
    seeLiteLoss: { on: ["4k3/8/3p4/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"], off: ["4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"] },
    capturesQueen: { on: ["4k3/8/8/4q3/8/5N2/8/4K3 w - - 0 1", "f3e5"], off: ["4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"] },
    captureWhenAhead: { on: ["4k3/8/8/4p3/3Q4/4B3/8/4K3 w - - 0 1", "d4e5"], off: ["3qk3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"] },
    captureWhenBehind: { on: ["3qk3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"], off: ["4k3/8/8/4p3/3Q4/4B3/8/4K3 w - - 0 1", "d4e5"] },
    isPromotion: { on: ["7k/4P3/8/8/8/8/8/4K3 w - - 0 1", "e7e8q"], off: ["4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", "e2e4"] },
    isCastle: { on: ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1"], off: ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "e2e4"] },
    kingMoveNonCastle: { on: ["4k3/8/8/8/8/8/8/4K3 w - - 0 1", "e1f1"], off: ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1"] },
    pawnPushOwnKingWing: { on: ["4k3/8/8/8/8/3PP3/5PP1/5K2 w - - 0 1", "g2g3"], off: ["4k3/8/8/8/8/3PP3/5PP1/5K2 w - - 0 1", "d2d3"] },
    checkResponseBlock: { on: ["4k3/8/8/8/7q/8/6P1/4K3 w - - 0 1", "g2g3"], off: ["4k3/8/8/8/8/8/6P1/4K3 w - - 0 1", "g2g3"] },
    checkResponseCapture: { on: ["4k3/8/8/8/8/8/5N2/4K2r w - - 0 1", "f2h1"], off: ["4k3/8/8/8/8/8/8/4K3 w - - 0 1", "e1f1"] },
    checkResponseKingMove: { on: ["4k3/8/8/8/8/8/5N2/4K2r w - - 0 1", "e1e2"], off: ["4k3/8/8/8/8/8/6P1/4K3 w - - 0 1", "e1e2"] },
    givesCheck: { on: ["4k3/8/8/8/6P1/8/8/4K2Q w - - 0 1", "h1h8"], off: ["4k3/8/8/8/8/8/8/4K2Q w - - 0 1", "h1g1"] },
    movesTowardEnemyKing: { on: ["4k3/8/8/8/8/3N4/8/4K3 w - - 0 1", "d3e5"], off: ["4k3/8/8/8/8/3N4/8/4K3 w - - 0 1", "d3c1"] },
    pawnAdvancePastMidline: { on: ["4k3/8/8/3P4/8/8/8/4K3 w - - 0 1", "d5d6"], off: ["4k3/8/8/8/3P4/8/8/4K3 w - - 0 1", "d2d3"] },
    centralPawnPush: { on: ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "d2d4"], off: ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "a2a3"] },
    pieceRetreat: { on: ["4k3/8/4N3/8/8/8/8/4K3 w - - 0 1", "e6c5"], off: ["4k3/8/4N3/8/8/8/8/4K3 w - - 0 1", "e6g7"] },
    fianchetto: { on: ["4k3/8/8/8/8/8/8/B3K3 w - - 0 1", "a1b2"], off: ["4k3/8/8/8/8/8/8/B3K3 w - - 0 1", "a1c3"] },
    resolvesPawnTension: { on: ["4k3/8/3p4/4P3/8/8/8/4K3 w - - 0 1", "e5d6"], off: ["4k3/8/8/4P3/8/8/8/4K3 w - - 0 1", "e4e5"] },
    rookLift: { on: ["4k3/8/8/8/8/8/8/R3K3 w - - 0 1", "a1a3"], off: ["4k3/8/8/8/8/8/8/R3K3 w - - 0 1", "a1b1"] },
    knightToRim: { on: ["4k3/8/8/8/8/2N5/8/4K3 w - - 0 1", "c3a4"], off: ["4k3/8/8/8/8/2N5/8/4K3 w - - 0 1", "c3e4"] },
    developsMinorFromHome: { on: ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "g1f3"], off: ["4k3/8/8/8/8/3N4/8/4K3 w - - 0 1", "d3e5"] },
    movesSamePieceAgain: {
      on: ["4k3/8/8/8/8/3N4/8/4K3 w - - 0 1", "d3e5", { prevOwnMoveUci: "f1d3" }],
      off: ["4k3/8/8/8/8/3N4/8/4K3 w - - 0 1", "d3e5", { prevOwnMoveUci: null }],
    },
    quietPawnPush: { on: ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "e2e4"], off: ["4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5"] },
    minorPieceToCenter: { on: ["4k3/8/8/8/8/3N4/8/4K3 w - - 0 1", "d3e5"], off: ["4k3/8/8/8/8/3N4/8/4K3 w - - 0 1", "d3b4"] },
    queenMove: { on: ["4k3/8/8/8/8/8/8/4K2Q w - - 0 1", "h1h5"], off: ["4k3/8/8/8/8/3N4/8/4K3 w - - 0 1", "d3e5"] },
    pawnCapture: { on: ["4k3/8/3p4/4P3/8/8/8/4K3 w - - 0 1", "e5d6"], off: ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "e2e4"] },
    createsPassedPawn: { on: ["4k3/8/8/8/8/8/3P4/4K3 w - - 0 1", "d2d4"], off: ["4k3/3p4/8/8/8/8/3P4/4K3 w - - 0 1", "d2d4"] },
    attacksCenter: { on: ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "e2e4"], off: ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "a2a3"] },
    hangingPieceCapture: { on: ["4k3/8/8/4q3/8/5N2/8/4K3 w - - 0 1", "f3e5"], off: ["4k3/8/3b4/4q3/8/5N2/8/4K3 w - - 0 1", "f3e5"] },
    defendsOwnPiece: { on: ["4k3/8/4q3/8/4N3/8/5K2/R7 w - - 0 1", "a1e1"], off: ["4k3/8/4q3/8/4N3/8/5K2/R7 w - - 0 1", "a1a5"] },
  };

  const spec = cases[id];
  if (!spec) {
    it.todo(`fixtures for ${id}`);
    return;
  }

  it("fires on a hand-built positive fixture", () => {
    const [fen, uci, opts] = spec.on;
    expect(feat(vecAt(fen, uci, opts || {}), id)).toBeGreaterThan(0);
  });

  it("is zero on a hand-built negative fixture", () => {
    const [fen, uci, opts] = spec.off;
    expect(feat(vecAt(fen, uci, opts || {}), id)).toBe(0);
  });
});

describe("feature sweep", () => {
  const fens = [
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
    "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    "r1bqk2r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3",
    "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
    "4k3/8/8/8/8/3q4/8/4K3 w - - 0 1",
  ];

  for (const fen of fens) {
    it(`all legal moves are finite for ${fen.slice(0, 24)}…`, () => {
      const ctx = ctxAt(fen);
      const chess = new Chess(fen);
      for (const uci of chess.moves().map((m) => m.slice(0, 2) + m.slice(2, 4) + (m[4] || ""))) {
        const vec = featureVector(ctx, uci);
        expect(vec.length).toBe(FEATURE_IDS.length);
        for (let i = 0; i < vec.length; i += 1) {
          expect(Number.isFinite(vec[i])).toBe(true);
        }
      }
    });
  }
});

describe("relative-coordinate mirror invariance", () => {
  const pairs = [
    ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "e2e4"],
    ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "g1f3"],
    ["rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", "e7e5"],
    ["r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", "e1g1"],
  ];

  for (const [fen, uci] of pairs) {
    it(`mirrors ${uci} at ${fen.slice(0, 20)}…`, () => {
      const mirroredFen = mirrorFen(fen);
      const mirroredUci = mirrorMove(uci);
      const a = vecAt(fen, uci);
      const b = vecAt(mirroredFen, mirroredUci);
      expect([...b]).toEqual([...a]);
    });
  }
});

describe("decisionMeta", () => {
  it("exposes phase, queenless, and material diff", () => {
    const ctx = ctxAt("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    const meta = decisionMeta(ctx);
    expect(["opening", "middlegame", "endgame"]).toContain(meta.phase);
    expect(meta.queenless).toBe(0);
    expect(meta.materialDiffMover).toBe(0);
  });
});