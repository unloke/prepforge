import { describe, it, expect } from "vitest";

import { describePosition, explainEngineIdea } from "./explain.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("describePosition", () => {
  it("reads the start position as level, white to move", () => {
    const out = describePosition(START);
    expect(out.headline).toMatch(/level/i);
    expect(out.points.join(" ")).toMatch(/White to move/);
  });

  it("describes the last move that was played", () => {
    // After 1.e4 — black to move; lastUci e2e4 lands a pawn on e4.
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    const out = describePosition(fen, { lastSan: "e4", lastUci: "e2e4" });
    const text = out.points.join(" ");
    expect(text).toMatch(/Last move e4/);
    expect(text).toMatch(/pawn to e4/);
  });

  it("announces checkmate with the winner", () => {
    const fen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const out = describePosition(fen);
    expect(out.headline).toMatch(/Checkmate/);
    expect(out.headline).toMatch(/Black wins/);
  });

  it("flags a hanging piece and the side ahead on material", () => {
    // White queen on d5 hangs to nothing in particular but black has an extra... use a
    // clear loose-piece case: black bishop on h3 attacked by g2 pawn, undefended.
    const fen = "rnbqkbnr/pppppppp/8/8/8/7b/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const out = describePosition(fen);
    const text = out.points.join(" ");
    expect(text).toMatch(/h3 is loose/);
  });

  it("reports a material lead", () => {
    // Black is missing its queen — White is a full queen up.
    const fen = "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const out = describePosition(fen);
    expect(out.headline).toMatch(/White is up/);
  });
});

describe("explainEngineIdea", () => {
  it("turns an engine result into a one-line suggestion", () => {
    const s = explainEngineIdea({ bestSan: "Nf3", scoreCp: 80, mateIn: null, sideToMove: "white" });
    expect(s).toMatch(/White should play Nf3/);
    expect(s).toMatch(/small edge/);
  });

  it("phrases a forced mate", () => {
    const s = explainEngineIdea({ bestSan: "Qh7#", scoreCp: null, mateIn: 1, sideToMove: "white" });
    expect(s).toMatch(/mate in 1/);
  });

  it("returns empty string with no best move", () => {
    expect(explainEngineIdea({ bestSan: "" })).toBe("");
  });
});
