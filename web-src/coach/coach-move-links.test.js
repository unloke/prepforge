// Every move the Analyze coach names is a move link. The coach writes the move it
// is about and its alternative without a number ("c6 is fine. d6 was more
// precise.", "b5 allows 9.Nxf7"), so the tokenizer reads its sentences in prose
// mode (move-links.js analysisTextContext). This walks the coach over a real game
// (every ply, read for each side) and checks that no move is left as plain text,
// that each token names the move its text says, and that squares stay squares.
import { describe, expect, it } from "vitest";
import fixture from "./coach-links-fixture.json";
import { buildMoveFeatures } from "./features.js";
import { buildCommentary } from "./commentary.js";
import { parseMoveText, walkLine } from "../move-text.js";

const MOVE = /(?<![\w])(?:\d{1,3}\s?(?:\.\.\.|…|\.)\s?)?(?:O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=?[QRBN])?|[a-h][1-8](?:=?[QRBN])?)[+#]?(?![\w])/g;
const PLACE = /\b(?:on|to|of|the|guard(?:s|ed)?|attacks?|hits?|defends?)\s+$/i;

function lineOf(fen) {
  const e = fixture.position_evals[fen];
  if (!e) return null;
  const line = walkLine(fen, e.pv || []);
  return { uci: e.best_move_uci, san: line?.plies[0]?.san, cp: e.score_cp, mate: e.mate_in, pvUci: e.pv || [], pvSan: (line?.plies || []).map((p) => p.san) };
}

function reads() {
  const fens = [fixture.moves[0].fen_before, ...fixture.moves.map((m) => m.fen_after)];
  const out = [];
  for (const m of fixture.moves) {
    const before = lineOf(m.fen_before);
    const after = lineOf(m.fen_after);
    if (!before) continue;
    for (const selfSide of [null, "white", "black"]) {
      const features = buildMoveFeatures({
        ply: m.ply, moveNumber: m.move_number, mover: m.side, uci: m.uci, san: m.san,
        fenBefore: m.fen_before, fenAfter: m.fen_after, beforeEval: { lines: [before] },
        afterEval: after ? { cp: after.cp, mate: after.mate, pvUci: after.pvUci, pvSan: after.pvSan } : { cp: 0, mate: null, pvUci: [] },
      });
      features.opponentRead = !!selfSide && selfSide !== m.side;
      const { prose } = buildCommentary(features, { selfSide });
      if (prose) out.push({ m, prose, segs: parseMoveText(prose, { fen: m.fen_before, pawns: "prose", at: (ply) => fens[ply] }) });
    }
  }
  return out;
}

describe("the Analyze coach's moves are links", () => {
  const all = reads();

  it("reads the whole game", () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it("leaves no move as plain text", () => {
    const missed = [];
    for (const { prose, segs } of all) {
      const text = segs.filter((s) => typeof s === "string").join(" | ");
      for (const hit of text.matchAll(MOVE)) {
        if (/^[a-h][1-8]/.test(hit[0]) && PLACE.test(text.slice(Math.max(0, hit.index - 12), hit.index))) continue;
        missed.push(`${hit[0]} in "${prose}"`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("links each token to the move its text names, and never a square", () => {
    for (const { prose, segs } of all) {
      segs.forEach((seg, i) => {
        if (typeof seg === "string") return;
        const said = seg.text.replace(/^\d+\s?(?:\.\.\.|…|\.)\s?/, "").replace(/[+#!?]+$/, "");
        expect(seg.label.replace(/^\d+\.+/, "").replace(/[+#]$/, ""), prose).toBe(said);
        const lead = typeof segs[i - 1] === "string" ? segs[i - 1] : "";
        if (/^[a-h][1-8]$/.test(said)) expect(/\bon\s+$/.test(lead), prose).toBe(false);
      });
    }
  });

  it("reads 'X was the move' as the alternative to the move played", () => {
    const fens = [fixture.moves[0].fen_before, ...fixture.moves.map((m) => m.fen_after)];
    // 14...c5 allows 15.Bd5; the better move was Black's 14...d5, not White's 15.d5.
    const m = fixture.moves.find((x) => x.ply === 28);
    const segs = parseMoveText("c5 allows 15.Bd5, when the bishop on d5 attacks the rook on a8. d5 was the move.", { fen: m.fen_before, pawns: "prose", at: (ply) => fens[ply] });
    const tokens = segs.filter((s) => typeof s !== "string").map((s) => s.label);
    expect(tokens).toEqual(["14...c5", "15.Bd5", "14...d5"]);
  });
});
