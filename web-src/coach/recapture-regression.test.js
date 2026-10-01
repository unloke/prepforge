import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { walkLine, materialBalance, perPieceDiff } from "./material.js";
import { buildMoveFeatures } from "./features.js";
import { buildCommentary } from "./commentary.js";
import { fmt, PUNISH_WITH_REPLY_COUNT, PUNISH_NO_REPLY_COUNT } from "./phrasebank.js";

const PGN = `[White "Me"]
[Black "Opp"]

1. e4 c6 2. d4 d5 3. f3 dxe4 4. fxe4 e5 5. Nf3 exd4 6. Bc4 Nf6 7. O-O Bc5 8. e5 Ng4 9. Bxf7+ Kxf7 10. Ng5+ Kg8 11. Qxg4 Qe7 12. Qf3 h6 13. Nh3 Bxh3 14. gxh3 1-0`;
const chess = new Chess();
chess.loadPgn(PGN);
const fenAfter = chess.fen();
chess.undo();
const fenBefore = chess.fen();
const PV = ["b8d7", "f3b3", "g8h7", "b3d3", "g7g6", "c1f4", "h8f8", "b1d2", "d7e5", "d3b3"];

function features(pv = PV) {
  return buildMoveFeatures({
    ply: 27, moveNumber: 14, mover: "white", san: "gxh3", uci: "g2h3", fenBefore, fenAfter,
    beforeEval: { lines: [{ uci: "f3h3", san: "Qxh3", cp: 0, pvUci: ["f3h3"] }] },
    afterEval: { cp: -126, pvUci: pv, pvSan: ["Nd7"] },
  });
}

describe("14.gxh3 recapture in the supplied game", () => {
  it.each(["g2h3", "f3h3"])("%s restores exactly level material", (uci) => {
    const line = walkLine(fenBefore, [uci]);
    expect(line.settledStartBalance).toBe(0);
    expect(line.settledEndBalance).toBe(0);
    expect(line.settledSwing).toBe(0);
    expect(line.settledDiffSwing).toEqual({ p: 0, n: 0, b: 0, r: 0, q: 0 });
    expect(materialBalance(new Chess(line.endFen))).toBe(0);
  });

  it("the later Nxe5 loses only a pawn, with all pieces still equal", () => {
    const line = walkLine(fenBefore, ["g2h3", ...PV]);
    expect(line.settledEndBalance).toBe(-1);
    expect(line.settledEndDiff).toEqual({ p: -1, n: 0, b: 0, r: 0, q: 0 });
    expect(line.settledDiffSwing).toEqual(line.settledEndDiff);
    expect(perPieceDiff(new Chess(line.endFen))).toEqual(line.settledEndDiff);
  });

  it.each([[], PV.slice(0, 8), PV].map((pv) => ({ pv })))
  ("does not call the level recapture a material loss (PV $pv)", ({ pv }) => {
    const f = features(pv);
    expect(f.classification.code).toBe("mistake");
    const prose = buildCommentary(f).prose;
    expect(prose).toMatch(/gxh3/);
    expect(prose).toMatch(/Qxh3/);
    expect(prose).not.toMatch(/costs material|loses material|gives material away|bishop.*for a knight/i);
    expect(prose).toMatch(/material.*level|level.*material/i);
    if (pv === PV) expect(prose).toMatch(/pawn/);
  });
});

it("every line-loss template describes a gain, not an absolute material lead", () => {
  // Black was already a rook for two pawns up; losing those pawns changes
  // the balance by two, but does not leave Black only two pawns ahead.
  for (const bank of [PUNISH_WITH_REPLY_COUNT, PUNISH_NO_REPLY_COUNT]) {
    for (const template of bank) {
      const prose = fmt(template, { opp: "Black", phrase: "two pawns", reply: "Rxa2" });
      expect(prose).not.toMatch(/ahead|\bup\b|to the good/);
      expect(prose).toMatch(/two pawns/);
      expect(prose).not.toMatch(/\{\w+\}/);
    }
  }
});
