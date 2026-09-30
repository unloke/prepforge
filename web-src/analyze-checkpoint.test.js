import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkpointKey,
  clearCheckpoint,
  evalMapFrom,
  loadCheckpoint,
  saveCheckpoint,
} from "./analyze-checkpoint.js";

// F-03: the finished-but-unsaved analysis lives on the device so a failed
// classify-save never costs a re-analysis (retry = re-post only) and a reload
// can pick the work back up.

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const sample = {
  gameId: "g42",
  engine: "stockfish (browser)",
  depth: 18,
  positions: ["fen-a", "fen-b"],
  evals: [
    ["fen-a", { score_cp: 20, best_move_uci: "e2e4", depth: 18, nodes: 1000 }],
    ["fen-b", { mate_in: 3, pv: ["e2e4", "e7e5"] }],
  ],
  maiaAssessments: [{ ply: 1, kind: "brilliant" }],
  pgn: "1. e4 e5",
};

describe("analyze checkpoint store", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keys by game identity and round-trips the computed work", () => {
    expect(checkpointKey("g42")).toContain("g42");
    expect(checkpointKey("g42")).not.toBe(checkpointKey("g43"));
    expect(saveCheckpoint(sample)).toBe(true);
    const loaded = loadCheckpoint("g42");
    expect(loaded.gameId).toBe("g42");
    expect(loaded.positions).toEqual(["fen-a", "fen-b"]);
    expect(loaded.evals).toEqual(sample.evals);
    expect(loaded.maiaAssessments).toEqual(sample.maiaAssessments);
    expect(loaded.pgn).toBe("1. e4 e5");
    expect(loaded.savedAt).toBeGreaterThan(0);
  });

  it("keeps games isolated and finds any game when the id is omitted", () => {
    saveCheckpoint(sample);
    saveCheckpoint({ ...sample, gameId: "g43" });
    expect(loadCheckpoint("g42").gameId).toBe("g42");
    expect(loadCheckpoint("g43").gameId).toBe("g43");
    expect(loadCheckpoint("missing")).toBeNull();
    // A reload that lost the id can still recover the orphaned work.
    expect(loadCheckpoint().gameId).toBeTruthy();
  });

  it("clears only the confirmed game's checkpoint", () => {
    saveCheckpoint(sample);
    saveCheckpoint({ ...sample, gameId: "g43" });
    clearCheckpoint("g42");
    expect(loadCheckpoint("g42")).toBeNull();
    expect(loadCheckpoint("g43")).not.toBeNull();
  });

  it("keeps a caller-provided savedAt", () => {
    saveCheckpoint({ ...sample, savedAt: 123 });
    expect(loadCheckpoint("g42").savedAt).toBe(123);
  });

  it("refuses oversized checkpoints instead of overflowing storage", () => {
    const huge = { ...sample, pgn: "x".repeat(4_000_001) };
    expect(saveCheckpoint(huge)).toBe(false);
    expect(loadCheckpoint("g42")).toBeNull();
  });

  it("degrades quietly when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      key: () => {
        throw new Error("blocked");
      },
      length: 0,
    });
    expect(saveCheckpoint(sample)).toBe(false);
    expect(loadCheckpoint("g42")).toBeNull();
    expect(loadCheckpoint()).toBeNull();
    expect(() => clearCheckpoint("g42")).not.toThrow();
  });

  it("evalMapFrom rebuilds the fen-keyed map, skipping malformed pairs", () => {
    const map = evalMapFrom({ evals: [["fen-a", { score_cp: 1 }], ["bad"], null, "x"] });
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(1);
    expect(map.get("fen-a")).toEqual({ score_cp: 1 });
    expect(evalMapFrom(null).size).toBe(0);
    expect(evalMapFrom({}).size).toBe(0);
  });
});
