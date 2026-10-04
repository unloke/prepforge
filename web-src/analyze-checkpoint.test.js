import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  checkpointKey,
  clearCheckpoint,
  evalMapFrom,
  listCheckpointGames,
  loadCheckpoint,
  saveCheckpoint,
} from "./analyze-checkpoint.js";

const root = dirname(fileURLToPath(import.meta.url));

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
    expect(checkpointKey("g42")).not.toBe(checkpointKey("g43", "a"));
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

  it("evicts payloads with index entries and keeps other owners intact", () => {
    saveCheckpoint({ ...sample, ownerId: "b" });
    for (let i = 1; i <= 51; i++) {
      expect(saveCheckpoint({ ...sample, gameId: `g${i}`, ownerId: "a", savedAt: i })).toBe(true);
    }
    expect(listCheckpointGames("a")).toHaveLength(50);
    expect(loadCheckpoint("g1", "a")).toBeNull();
    for (const { gameId } of listCheckpointGames("a")) clearCheckpoint(gameId, "a");
    expect(localStorage.length).toBe(3); // two owner indexes and B's payload
    expect(loadCheckpoint("g42", "b")).not.toBeNull();
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

// F-04: checkpoints are owner-scoped and the "no id" lookup picks the NEWEST
// one, so a shared machine never offers another account's pending save and a
// reload never retries an arbitrary game.

describe("analyze checkpoint ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scopes keys per owner", () => {
    expect(checkpointKey("g42", "owner-a")).not.toBe(checkpointKey("g42", "owner-b"));
    saveCheckpoint({ ...sample, ownerId: "owner-a" });
    expect(loadCheckpoint("g42", "owner-a").gameId).toBe("g42");
    expect(loadCheckpoint("g42", "owner-b")).toBeNull();
    expect(loadCheckpoint(null, "owner-b")).toBeNull();
  });

  it("returns the newest checkpoint, not the first key found", () => {
    saveCheckpoint({ ...sample, ownerId: "a", savedAt: 100 });
    saveCheckpoint({ ...sample, gameId: "g99", ownerId: "a", savedAt: 500 });
    saveCheckpoint({ ...sample, gameId: "g50", ownerId: "a", savedAt: 300 });
    expect(loadCheckpoint(null, "a").gameId).toBe("g99");
    expect(listCheckpointGames("a").map((entry) => entry.gameId)).toEqual(["g99", "g50", "g42"]);
  });

  it("clears only the addressed game's entry and its index row", () => {
    saveCheckpoint({ ...sample, ownerId: "a" });
    saveCheckpoint({ ...sample, gameId: "g43", ownerId: "a" });
    clearCheckpoint("g42", "a");
    expect(loadCheckpoint("g42", "a")).toBeNull();
    expect(loadCheckpoint("g43", "a")).not.toBeNull();
    expect(listCheckpointGames("a").map((entry) => entry.gameId)).toEqual(["g43"]);
  });

  // The signature is loadCheckpoint(gameId, ownerId). Passing the owner in the
  // first slot reads the "anon" bucket keyed by the owner id, so a signed-in
  // user's own checkpoint is never found and the "unsaved analysis" prompt
  // silently never appears. Guard the real call sites in app.js.
  it("reads the owner from the SECOND argument", () => {
    saveCheckpoint({ ...sample, ownerId: "owner-a" });
    // Wrong slot: owner id used as a game id, owner undefined -> "anon".
    expect(loadCheckpoint("owner-a")).toBeNull();
    expect(loadCheckpoint(null, "owner-a").gameId).toBe("g42");
  });

  it("app.js never passes the owner id in the gameId slot", () => {
    const app = readFileSync(join(root, "app.js"), "utf8");
    // Strip line comments so a signature mentioned in prose is not a call.
    const code = app.replace(/\/\/.*$/gm, "");
    const calls = code.match(/loadCheckpoint\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const args = call.slice("loadCheckpoint(".length, -1);
      const first = args.split(",")[0].trim();
      // Either an explicit game id or the null "newest for this owner" form.
      expect(["null", ""]).toContain(first);
    }
  });
});
