import { describe, it, expect } from "vitest";
import { Chess } from "chess.js";

import { buildMoveFeatures } from "./features.js";
import { buildCommentary, bucket } from "./commentary.js";
import { lineOutcome, netFor, gainPhrase, numberLine } from "./move-facts.js";
import { motifPhrase, participle, hangingCapture } from "./motifs.js";
import RATED from "./fixtures/rated-moves.json";

function play(fen, sans) {
  const c = new Chess(fen);
  const out = [];
  for (const san of sans) {
    const mv = c.move(san);
    out.push(mv.from + mv.to + (mv.promotion || ""));
  }
  return out;
}

// A move with a best line and a played line, given as SAN from fenBefore.
function scenario({ fen, san, best, bestLine, playedLine, before = 0, after = 0, mover, prev, ply = 1 }) {
  const c = new Chess(fen);
  const mv = c.move(san);
  const fenAfter = c.fen();
  const bestUcis = play(fen, bestLine || [best]);
  const playedUcis = play(fenAfter, playedLine || []);
  return buildMoveFeatures({
    ply,
    mover: mover || (fen.split(" ")[1] === "w" ? "white" : "black"),
    uci: mv.from + mv.to,
    san: mv.san,
    fenBefore: fen,
    fenAfter,
    prevSan: prev?.san ?? null,
    prevUci: prev?.uci ?? null,
    prevFenBefore: prev?.fenBefore ?? null,
    beforeEval: { lines: [{ uci: bestUcis[0], san: best, cp: before, mate: null, pvUci: bestUcis, pvSan: bestLine || [best] }] },
    afterEval: { cp: after, mate: null, pvUci: playedUcis, pvSan: playedLine || [] },
  });
}

describe("rated positions from coach-review-ratings.json (real Stockfish lines)", () => {
  // Each of these was marked wrong under the old coach; the expected prose is the new read.
  for (const { input, prose } of RATED) {
    it(`${input.san} (ply ${input.ply})`, () => {
      expect(buildCommentary(buildMoveFeatures(input), { selfSide: "white" }).prose).toBe(prose);
    });
  }

  it("never claims a pin, space or open diagonal, and never restates a static material count", () => {
    for (const { prose } of RATED) {
      expect(prose).not.toMatch(/(pins?|pinned|space|diagonal|eyes)|two pawns to the good|extra two pawns/i);
    }
  });

  it("names both pieces a double attack hits", () => {
    const rc6 = RATED.find((r) => r.input.san === "Rc6");
    expect(rc6.prose).toMatch(/27\.\.\.Ne5, which hits the rook on c6 and the bishop on f3/);
  });

  it("calls an even exchange a trade, and the opposite-coloured bishops it leaves", () => {
    const rxd4 = RATED.find((r) => r.input.san === "Rxd4");
    expect(rxd4.prose).toMatch(/trades rooks, leaving opposite-coloured bishops/);
    expect(rxd4.prose).not.toMatch(/takes back|takes it back/);
  });
});

describe("move-facts material reading", () => {
  it("counts material at a quiet point of the engine line, not mid-exchange", () => {
    // 1.e4 d5 2.exd5 Qxd5: an even pawn trade, even though the line ends on a capture.
    const start = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const out = lineOutcome(start, play(start, ["d5", "exd5", "Qxd5", "Nc3"]));
    expect(out.quiet).toBe(true);
    expect(netFor(out, "w")).toEqual({ p: 0, n: 0, b: 0, r: 0, q: 0 });
  });

  it("reports an unfinished exchange as not quiet", () => {
    const start = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const out = lineOutcome(start, play(start, ["exd5"]));
    expect(out.quiet).toBe(false);
  });

  it("phrases imbalances the way players say them", () => {
    expect(gainPhrase({ r: 1, b: -1 })).toBe("the exchange");
    expect(gainPhrase({ b: 1, p: -1 })).toBe("a bishop for a pawn");
    expect(gainPhrase({ n: 1, b: 1, p: -2 })).toBe("two pieces for two pawns");
    expect(gainPhrase({ p: 2 })).toBe("two pawns");
  });

  it("numbers a line from the side to move", () => {
    expect(numberLine("8/8/8/8/8/8/8/K6k b - - 0 16", ["e5", "Qc2", "exd4"])).toBe("16...e5 17.Qc2 exd4");
  });
});

describe("buildCommentary", () => {
  it("recognizes a recapture even when the player was already ahead in material", () => {
    const prevFen = "6k1/8/8/3p4/4P3/5B2/8/1R4K1 b - - 0 1";
    const c = new Chess(prevFen);
    c.move("dxe4");
    const f = scenario({ fen: c.fen(), san: "Bxe4", best: "Bxe4", playedLine: ["Kf7"],
      prev: { san: "dxe4", uci: "d5e4", fenBefore: prevFen } });
    expect(buildCommentary(f).prose).toMatch(/takes back the pawn/);
  });
  it("prices a hanging piece by the line that takes it", () => {
    const f = scenario({
      fen: "6k1/8/2p5/8/8/8/8/5BK1 w - - 0 1",
      san: "Bb5",
      best: "Kf2",
      before: 0,
      after: -300,
      playedLine: ["cxb5", "Kf2"],
    });
    expect(buildCommentary(f).prose).toBe("Blunder. Bb5 hangs the bishop to 1...cxb5. Kf2 was the move, keeping the material.");
  });

  it("names the fork the reply executes instead of a bare material count", () => {
    const f = scenario({
      fen: "r3k3/7p/8/1N6/8/8/8/4K3 b - - 0 1",
      san: "h6",
      best: "Kd7",
      before: 0,
      after: 500,
      playedLine: ["Nc7+", "Kd7", "Nxa8", "Kc8"],
    });
    expect(buildCommentary(f).prose).toBe("Blunder. h6 loses a rook to 2.Nc7+, which forks the king and the rook on a8. Kd7 was the move, keeping the material.");
  });

  it("names the tactic in the line the player missed", () => {
    const f = scenario({
      fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1",
      san: "Kd2",
      best: "Nc7+",
      bestLine: ["Nc7+", "Kd7", "Nxa8", "Kc8"],
      before: 500,
      after: 0,
      playedLine: ["Ra5", "Nc3"],
    });
    expect(buildCommentary(f).prose).toBe("Blunder. Kd2 misses Nc7+, which forks the king and the rook on a8 and wins a rook.");
  });

  it("leads a winning move's read with the tactic that wins the material", () => {
    const f = scenario({
      fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1",
      san: "Nc7+",
      best: "Nc7+",
      bestLine: ["Nc7+", "Kd7", "Nxa8", "Kc8"],
      before: 500,
      after: 500,
      playedLine: ["Kd7", "Nxa8", "Kc8"],
    });
    expect(buildCommentary(f).prose).toBe("Good move. Nc7+ forks the king and the rook on a8, winning a rook.");
  });

  it("does not call a defended piece hanging", () => {
    expect(hangingCapture("6k1/8/2p5/1B6/P7/8/8/6K1 b - - 0 1", "c6b5")).toBeNull();
    expect(hangingCapture("6k1/8/2p5/1B6/8/8/8/6K1 b - - 0 1", "c6b5")).toEqual({ type: "b", square: "b5" });
  });

  it("names pins and skewers set up by the moved piece", () => {
    expect(motifPhrase("3k4/8/5n2/8/7B/8/8/4K3 w - - 0 1", "h4g5", "Bg5")).toBe("pins the knight to the king");
    expect(motifPhrase("4r1k1/8/8/4q3/8/8/4R3/3K4 w - - 0 1", "e2e1", "Re1")).toBe("skewers the queen and the rook behind it");
    expect(motifPhrase("3k4/8/8/8/8/8/8/1N2K3 w - - 0 1", "b1c3", "Nc3")).toBe("");
    expect(["forks a", "pins a", "skewers a"].map(participle)).toEqual(["forking a", "pinning a", "skewering a"]);
  });

  it("speaks to the user as 'you' and to the opponent by colour", () => {
    const f = scenario({
      fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
      san: "a3",
      best: "Bb5",
      before: 120,
      after: -10,
      playedLine: ["Nf6"],
    });
    expect(buildCommentary(f, { selfSide: "white" }).prose).toBe(
      "Mistake. a3 allows 3...Nf6, which develops the knight and attacks the pawn on e4. You were slightly better; now it's level. Bb5 was the move, keeping you slightly better.",
    );
    expect(buildCommentary(f).prose).toMatch(/White was slightly better; now it's level\./);
  });

  it("does not narrate a gain when the two searches disagree on an inaccuracy", () => {
    const f = scenario({
      fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
      san: "h3",
      best: "Bb5",
      before: 40,
      after: 90,
      playedLine: ["Nf6"],
    });
    // Classified from the win% drop only through isBest; force an inaccuracy for the wording.
    f.classification = { code: "inaccuracy", label: "Inaccuracy", glyph: "?!", tone: "warn" };
    f.winAfterMover = f.winBeforeMover + 8;
    expect(buildCommentary(f).prose).toBe("h3 is slightly inaccurate. Bb5 was better.");
  });

  it("tells a take-back from the capture that starts a new trade", () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Bb5 Nf6 4.Bxc6 dxc6: dxc6 takes back the bishop.
    const fen = "r1bqkb1r/pppp1ppp/2B2n2/4p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4";
    const prevFenBefore = "r1bqkb1r/pppp1ppp/2n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    const takeBack = scenario({
      fen,
      san: "dxc6",
      best: "dxc6",
      before: 0,
      after: 0,
      playedLine: ["O-O"],
      prev: { san: "Bxc6", uci: "b5c6", fenBefore: prevFenBefore },
    });
    expect(buildCommentary(takeBack).prose).toMatch(/dxc6 takes back the bishop\.$/);

    // Queens facing on the open d-file: ...Qxd1+ starts the trade and Kxd1 takes back, while a
    // queen capture that opens the exchange is a trade, not a take-back.
    const qFen = "rnb1kbnr/ppp2ppp/8/4p3/4P3/8/PPP2PPP/R2qKBNR w KQkq - 0 4";
    const qPrev = "rnbqkbnr/ppp2ppp/8/4p3/4P3/8/PPP2PPP/R2QKBNR b KQkq - 0 3";
    const kxd1 = scenario({
      fen: qFen,
      san: "Kxd1",
      best: "Kxd1",
      playedLine: ["Nc6"],
      prev: { san: "Qxd1+", uci: "d8d1", fenBefore: qPrev },
    });
    expect(buildCommentary(kxd1).prose).toMatch(/Kxd1 takes back the queen/);
    const qxd8 = scenario({
      fen: qPrev.replace(" b ", " w "),
      san: "Qxd8+",
      best: "Qxd8+",
      bestLine: ["Qxd8+", "Kxd8"],
      playedLine: ["Kxd8", "Nf3"],
      mover: "white",
    });
    expect(buildCommentary(qxd8).prose).toMatch(/Qxd8\+ trades queens/);
  });

  it("states checkmate and forced moves plainly", () => {
    const mate = scenario({
      fen: "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1",
      san: "Ra8#",
      best: "Ra8#",
      before: 0,
    });
    mate.afterEval = { mate: 1 };
    expect(buildCommentary(mate, { selfSide: "white" }).prose).toBe("Checkmate. Well played.");
    expect(buildCommentary(mate).prose).toBe("Checkmate.");
  });

  it("keeps every read short and clean", () => {
    for (const { prose } of RATED) {
      expect(prose.length).toBeLessThanOrEqual(240);
      expect(prose).not.toMatch(/\{|\}|undefined|null|NaN| {2}|(^|[^.])\.\.(?!\.)|—/);
      expect(prose.split(/(?<=[.!])\s/).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("bucket", () => {
  it("maps win% to the standing scale", () => {
    expect([90, 70, 60, 50, 40, 20, 5].map(bucket)).toEqual([3, 2, 1, 0, -1, -2, -3]);
  });
});
