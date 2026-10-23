import { describe, it, expect } from "vitest";
import { clampPly, decodeLine, encodeLine, moveLineHtml, moveTextHtml, parseMoveText, plyOfFen, previewPosition, walkLine, walkPathText } from "./move-text.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

describe("line walking and stepping", () => {
  it("walks the line from the board's position with numbered labels", () => {
    const p = walkLine(AFTER_E4, ["e7e5", "g1f3", "b8c6"]);
    expect(p.baseFen).toBe(AFTER_E4);
    expect(p.plies.map((x) => x.label)).toEqual(["1...e5", "2.Nf3", "2...Nc6"]);
    expect(p.plies[2].fen).toBe("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
  });

  it("stops at the first illegal move and rejects an empty or unusable line", () => {
    expect(walkLine(START, ["e2e4", "e2e4", "g8f6"]).plies).toHaveLength(1);
    expect(walkLine(START, [])).toBe(null);
    expect(walkLine("not a fen", ["e2e4"])).toBe(null);
  });

  it("shows the board's own position at ply 0 and the line's moves after it", () => {
    const p = walkLine(START, ["e2e4", "e7e5"]);
    expect(previewPosition(p, 0)).toEqual({ fen: START, lastMove: null });
    expect(previewPosition(p, 1)).toEqual({ fen: AFTER_E4, lastMove: "e2e4" });
    expect(previewPosition(p, 9).lastMove).toBe("e7e5");
    expect(clampPly(p, -4)).toBe(0);
  });
});

const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const tokens = (segs) => segs.filter((s) => typeof s !== "string");
const labels = (segs) => tokens(segs).map((t) => t.label);

describe("walkLine", () => {
  it("accepts SAN as well as UCI and names each ply", () => {
    const p = walkLine(START, ["e4", "e5", "Nf3", "O-O"]);
    expect(p.plies.map((x) => x.uci)).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(p.plies[1]).toMatchObject({ ply: 1, fenBefore: AFTER_E4 });
    expect(walkLine(START, ["0-0"])).toBe(null);
  });

  it("round-trips through the markup encoding", () => {
    const line = decodeLine(encodeLine(START, ["e2e4", "e7e5"]));
    expect(line.plies.map((x) => x.label)).toEqual(["1.e4", "1...e5"]);
    expect(decodeLine("garbage|e2e4")).toBe(null);
    expect(plyOfFen(AFTER_E4)).toBe(1);
    expect(plyOfFen(AFTER_E4_E5)).toBe(2);
  });
});

describe("parseMoveText", () => {
  it("links a numbered line and keeps the prose around it", () => {
    const segs = parseMoveText("Main line is 1.e4 e5 2.Nf3 Nc6, then 3.Bb5.", { fen: START });
    expect(labels(segs)).toEqual(["1.e4", "1...e5", "2.Nf3", "2...Nc6", "3.Bb5"]);
    expect(segs[0]).toBe("Main line is ");
    expect(segs[segs.length - 1]).toBe(".");
    expect(segs.map((s) => (typeof s === "string" ? s : s.text)).join("")).toBe("Main line is 1.e4 e5 2.Nf3 Nc6, then 3.Bb5.");
    // One line: every token carries it whole, at its own index.
    const t = tokens(segs);
    expect(t[4].line.ucis).toEqual(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]);
    expect(t.map((x) => x.index)).toEqual([0, 1, 2, 3, 4]);
    expect(t[0].line).toBe(t[4].line);
  });

  it("reads spaced numbers, ellipses and annotation marks", () => {
    expect(labels(parseMoveText("1. e4 e5 2. Nf3", { fen: START }))).toEqual(["1.e4", "1...e5", "2.Nf3"]);
    expect(labels(parseMoveText("1…e5!? is fine", { fen: AFTER_E4 }))).toEqual(["1...e5"]);
    expect(labels(parseMoveText("…Nf6 and …d5", { fen: AFTER_E4 }))).toEqual(["1...Nf6", "1...d5"]);
    const t = tokens(parseMoveText("2.Qh5?! Nc6", { fen: AFTER_E4_E5 }));
    expect(t[0].text).toBe("2.Qh5?!");
  });

  it("treats a second move with the same number as an alternative", () => {
    const t = tokens(parseMoveText("2.Nf3 or 2.Bc4", { fen: AFTER_E4_E5 }));
    expect(t.map((x) => x.label)).toEqual(["2.Nf3", "2.Bc4"]);
    expect(t[1].line.ucis).toEqual(["f1c4"]);
    expect(t[0].line.ucis).toEqual(["g1f3"]);
  });

  it("links unnumbered piece moves from the note's position, and their alternatives", () => {
    const t = tokens(parseMoveText("Nf3 is natural; Bc4 also works.", { fen: AFTER_E4_E5 }));
    expect(t.map((x) => x.label)).toEqual(["2.Nf3", "2.Bc4"]);
  });

  it("keeps a bare pawn square as text unless it follows a move or has a number", () => {
    expect(tokens(parseMoveText("the pawn on e5 is weak", { fen: START }))).toHaveLength(0);
    expect(tokens(parseMoveText("aim for d4 later", { fen: START }))).toHaveLength(0);
    expect(labels(parseMoveText("Nf3 d5 is the idea", { fen: START }))).toEqual(["1.Nf3", "1...d5"]);
    expect(labels(parseMoveText("1.d4 is the idea", { fen: START }))).toEqual(["1.d4"]);
    expect(labels(parseMoveText("New move: e4", { fen: START, pawns: true }))).toEqual(["1.e4"]);
  });

  it("reads a Train cue along the card's written path", () => {
    const path = walkPathText("1.e4 c6");
    expect(path.plies.map((p) => p.label)).toEqual(["1.e4", "1...c6"]);
    expect(walkPathText("1.e4 e4")).toBe(null);
    const at = (ply) => (ply ? path.plies[ply - 1]?.fen : START);
    const segs = parseMoveText("Weak spot · answer 1...c6", { fen: path.plies[1].fen, at });
    expect(labels(segs)).toEqual(["1...c6"]);
  });

  it("links a bare pawn capture: it never reads as a square", () => {
    const scandi = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    expect(labels(parseMoveText("Good move. exd5 takes the pawn.", { fen: scandi }))).toEqual(["2.exd5"]);
  });

  it("resolves an earlier move number through the note's path", () => {
    const at = (ply) => (ply === 0 ? START : ply === 1 ? AFTER_E4 : null);
    const segs = parseMoveText("Instead of 1...e5, 1...c5 is sharper.", { fen: AFTER_E4_E5, at });
    expect(labels(segs)).toEqual(["1...e5", "1...c5"]);
    expect(tokens(segs)[1].line.baseFen).toBe(AFTER_E4);
  });

  it("never links garbage, illegal moves or words that look like moves", () => {
    for (const text of ["", "Qxz9 and Kxx", "1.e5", "Nf6 here is illegal for White", "Ba1b", "Be3t", "12.Nc3", "version 1.2"]) {
      expect(tokens(parseMoveText(text, { fen: START }))).toHaveLength(0);
    }
    expect(parseMoveText(null, { fen: START })).toEqual([]);
    expect(tokens(parseMoveText("1.e4", { fen: "not a fen" }))).toHaveLength(0);
    expect(tokens(parseMoveText("1.e4 e5", {}))).toHaveLength(0);
  });

  it("handles castling written with zeros and promotions", () => {
    const fen = "r3k2r/1P6/8/8/8/8/8/R3K2R w KQkq - 0 30";
    expect(labels(parseMoveText("30.0-0 or 30.O-O-O", { fen }))).toEqual(["30.O-O", "30.O-O-O"]);
    expect(labels(parseMoveText("30.b8=Q+ wins", { fen }))).toEqual(["30.b8=Q+"]);
    expect(labels(parseMoveText("30.bxa8=Q", { fen }))).toEqual(["30.bxa8=Q+"]);
  });

  it("parses a long note quickly", () => {
    const sans = walkLine(START, ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"]).plies.map((p) => p.label);
    const text = Array.from({ length: 40 }, () => `The Najdorf: ${sans.join(" ")}.`).join(" ");
    const t0 = performance.now();
    const segs = parseMoveText(text, { fen: START });
    expect(performance.now() - t0).toBeLessThan(500);
    expect(tokens(segs).length).toBeGreaterThanOrEqual(10);
  });
});

describe("coach prose", () => {
  // The coach names the move played and its alternative without a number.
  it("links bare pawn moves, and leaves squares after a place word alone", () => {
    const segs = parseMoveText("Best move. e4 takes the centre and eyes d5.", { fen: START, pawns: "prose" });
    expect(tokens(segs).map((t) => t.label)).toEqual(["1.e4"]);
    const alt = parseMoveText("c4 is fine. d4 was slightly more precise; the pawn on e4 stays.", { fen: START, pawns: "prose" });
    expect(tokens(alt).map((t) => t.label)).toEqual(["1.c4", "1.d4"]);
  });

  it("reads a move after a full stop as the move's alternative, a move after a joiner as the line's next", () => {
    const segs = parseMoveText("e4 allows 1...e5 Nf3. d4 was the move.", { fen: START, pawns: "prose" });
    expect(tokens(segs).map((t) => t.label)).toEqual(["1.e4", "1...e5", "2.Nf3", "1.d4"]);
  });
});

describe("markup", () => {
  it("escapes the prose and marks tokens as buttons with their line", () => {
    const out = String(moveTextHtml("<b>1.e4</b>", { fen: START }));
    expect(out).toContain("&lt;b&gt;");
    expect(out).toMatch(/<span class="move-ref" role="button" tabindex="0" data-mt="[^"]+\|e2e4" data-p="0" aria-label="Preview 1.e4">1.e4<\/span>/);
    expect(String(moveTextHtml("no moves here", { fen: START }))).toBe("no moves here");
  });

  it("numbers a known line without playing it", () => {
    const out = String(moveLineHtml(AFTER_E4, ["e5", "Nf3", "Nc6"], ["e7e5", "g1f3", "b8c6"], { current: 1 }));
    expect(out.match(/class="move-ref-num">([^<]+)</g)).toHaveLength(2);
    expect(out).toContain(">1...</span>");
    expect(out).toContain('class="move-ref is-current"');
    // A move without its UCI stays plain numbered text.
    expect(String(moveLineHtml(START, ["e4", "e5"], ["e2e4"], {}))).toMatch(/data-p="0"[^>]*>e4<\/span> e5$/);
    // A long line is markup only: no chess work at render time.
    const many = Array.from({ length: 400 }, (_, i) => (i % 2 ? "e7e5" : "e2e4"));
    const t0 = performance.now();
    moveLineHtml(START, many, many);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
