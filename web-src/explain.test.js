import { describe, it, expect } from "vitest";

import {
  describePosition,
  describeMove,
  explainEngineIdea,
  classifyMove,
  cpToWin,
} from "./explain.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("cpToWin", () => {
  it("maps a dead-equal eval to 50%", () => {
    expect(Math.round(cpToWin(0))).toBe(50);
  });

  it("rises above 50 for White and falls below for Black", () => {
    expect(cpToWin(300)).toBeGreaterThan(60);
    expect(cpToWin(-300)).toBeLessThan(40);
  });

  it("saturates near 0/100 for huge evals", () => {
    expect(cpToWin(5000)).toBeGreaterThan(98);
    expect(cpToWin(-5000)).toBeLessThan(2);
  });
});

describe("describeMove", () => {
  it("calls a central pawn push grabbing the centre", () => {
    expect(describeMove(START, "e2e4", "e4")).toMatch(/pawn to e4.*centre/);
  });

  it("calls a knight sortie a development move", () => {
    expect(describeMove(START, "g1f3", "Nf3")).toMatch(/develops the knight/);
  });

  it("names a capture and the piece taken", () => {
    // 1.e4 d5 2.exd5 — White takes the pawn on d5.
    const fen = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    expect(describeMove(fen, "e4d5", "exd5")).toMatch(/takes the pawn on d5/);
  });

  it("recognises castling", () => {
    const fen = "rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    expect(describeMove(fen, "e1g1", "O-O")).toMatch(/castles/);
  });

  it("spots a knight fork of king and queen", () => {
    // Knight e5-f7 forks the king on h8 and queen on d8.
    const fen = "3q3k/8/8/4N3/8/8/8/7K w - - 0 1";
    expect(describeMove(fen, "e5f7", "Nf7+")).toMatch(/fork/i);
  });
});

describe("describePosition", () => {
  it("reads the start position as level, white to move", () => {
    const out = describePosition(START);
    expect(out.headline).toMatch(/Material is level/i);
    expect(out.points.join(" ")).toMatch(/White to move/);
  });

  it("leads the headline with what the last move did", () => {
    const after = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    const out = describePosition(after, { lastSan: "e4", lastUci: "e2e4", prevFen: START });
    expect(out.headline).toMatch(/White/);
    expect(out.headline).toMatch(/e4/);
    expect(out.headline).toMatch(/centre/);
  });

  it("announces checkmate with the winner", () => {
    const fen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const out = describePosition(fen);
    expect(out.headline).toMatch(/Checkmate/);
    expect(out.headline).toMatch(/Black wins/);
  });

  it("flags a hanging piece", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/8/7b/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const out = describePosition(fen);
    expect(out.points.join(" ")).toMatch(/h3 is loose/);
  });

  it("reports a material lead in the points", () => {
    // Black is missing its queen — White is a piece (well, a queen) up.
    const fen = "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const out = describePosition(fen);
    expect([out.headline, ...out.points].join(" ")).toMatch(/White is up/);
  });
});

describe("classifyMove", () => {
  it("grades a near-best move as Best", () => {
    const v = classifyMove({ winBefore: 60, winAfter: 59, mover: "white" });
    expect(v.label).toBe("Best move");
    expect(v.tone).toBe("good");
  });

  it("grades a big win-% drop as a Blunder", () => {
    const v = classifyMove({ winBefore: 62, winAfter: 30, mover: "white" });
    expect(v.label).toBe("Blunder");
    expect(v.tone).toBe("danger");
  });

  it("judges from the mover's point of view for Black", () => {
    // White-POV win % drops from 40 to 55 — that's good for White, bad for Black.
    const v = classifyMove({ winBefore: 40, winAfter: 55, mover: "black" });
    expect(v.label).toBe("Mistake");
  });

  it("returns null without both evaluations", () => {
    expect(classifyMove({ winBefore: null, winAfter: 50, mover: "white" })).toBeNull();
  });
});

describe("explainEngineIdea", () => {
  it("describes the best try and the resulting verdict", () => {
    const out = explainEngineIdea({
      fen: START,
      bestUci: "g1f3",
      bestSan: "Nf3",
      scoreCp: 30,
      mateIn: null,
      sideToMove: "white",
    });
    expect(out.text).toMatch(/Best is Nf3/);
    expect(out.text).toMatch(/develops the knight/);
    expect(out.text).toMatch(/balanced/);
    expect(out.tone).toBe("info");
  });

  it("phrases a forced mate and tones it green for the winner", () => {
    const out = explainEngineIdea({
      fen: null,
      bestSan: "Qh7#",
      scoreCp: null,
      mateIn: 1,
      sideToMove: "white",
    });
    expect(out.text).toMatch(/Qh7/);
    expect(out.text).toMatch(/mate in 1/);
    expect(out.tone).toBe("good");
  });

  it("returns empty text with no best move", () => {
    expect(explainEngineIdea({ bestSan: "" }).text).toBe("");
  });
});
