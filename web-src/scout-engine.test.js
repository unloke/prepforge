import { describe, expect, it } from "vitest";

import { mergeEngineIntoTargets, triePathKey } from "./scout.js";
import {
  aggregateEngineByTriePath,
  classifyOpponentMove,
  cpLossFromEvals,
  SCOUT_ENGINE_MIN_RECURRENCE,
} from "./scout-engine.js";

describe("scout-engine helpers", () => {
  it("computes centipawn loss from mover perspective", () => {
    expect(cpLossFromEvals(50, 20, "white")).toBe(30);
    expect(cpLossFromEvals(50, 80, "black")).toBe(30);
  });

  it("classifies white-to-move mistakes", () => {
    const result = classifyOpponentMove({
      fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      playedUci: "e2e3",
      bestUci: "e2e4",
      beforeCp: 20,
      afterCp: -120,
    });
    expect(result.cpLoss).toBeGreaterThan(0);
    expect(["Inaccuracy", "Mistake", "Blunder"]).toContain(result.classification?.label);
  });

  it("classifies black-to-move mistakes (White-POV win% into classifyMove)", () => {
    const result = classifyOpponentMove({
      fenBefore: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
      playedUci: "f7f6",
      bestUci: "e7e5",
      beforeCp: 100,
      afterCp: 280,
    });
    expect(result.mover).toBe("black");
    expect(result.cpLoss).toBeGreaterThan(0);
    expect(["Inaccuracy", "Mistake", "Blunder"]).toContain(result.classification?.label);
  });

  it("builds stable trie path keys", () => {
    expect(triePathKey(["e2e4", "c7c5"])).toBe("e2e4>c7c5");
  });

  it("only surfaces recurring mistake patterns", () => {
    const patterns = aggregateEngineByTriePath([
      [
        {
          pathKey: "e2e4>c7c5",
          pathSans: ["e4", "c5"],
          playedUci: "g8f6",
          playedSan: "Nf6",
          cpLoss: 140,
          classification: "Mistake",
          gameId: "a",
        },
      ],
      [
        {
          pathKey: "e2e4>c7c5",
          pathSans: ["e4", "c5"],
          playedUci: "g8f6",
          playedSan: "Nf6",
          cpLoss: 120,
          classification: "Mistake",
          gameId: "b",
        },
      ],
    ]);
    expect(patterns.size).toBe(1);
    expect(patterns.get("e2e4>c7c5").occurrences).toBeGreaterThanOrEqual(
      SCOUT_ENGINE_MIN_RECURRENCE,
    );
  });

  it("ignores one-off mistakes", () => {
    const patterns = aggregateEngineByTriePath([
      [
        {
          pathKey: "d2d4",
          pathSans: ["d4"],
          playedUci: "d7d5",
          playedSan: "d5",
          cpLoss: 200,
          classification: "Blunder",
          gameId: "a",
        },
      ],
    ]);
    expect(patterns.size).toBe(0);
  });

  it("merges engine patterns into weakness targets", () => {
    const targets = [
      { sans: ["e4", "c5"], ucis: ["e2e4", "c7c5"], games: 8, scorePct: 30, share: 0.4 },
    ];
    const patterns = new Map([
      [
        "e2e4>c7c5",
        {
          pathKey: "e2e4>c7c5",
          playedSan: "Nf6",
          occurrences: 3,
          avgCpLoss: 130,
        },
      ],
    ]);
    const merged = mergeEngineIntoTargets(targets, patterns);
    expect(merged[0].hasEngineMistake).toBe(true);
    expect(merged[0].enginePattern.playedSan).toBe("Nf6");
  });
});