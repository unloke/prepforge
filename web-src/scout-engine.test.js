import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import { mergeEngineIntoTargets, triePathKey } from "./scout.js";
import {
  aggregateEngineByFamily,
  aggregateEngineByTriePath,
  classifyOpponentMove,
  cpLossFromEvals,
  ENGINE_AGG_MIN_ANALYZED_GAMES,
  ENGINE_AGG_MIN_COVERAGE_PCT,
  ENGINE_CACHE_SCHEMA,
  engineScanPatterns,
  isCompleteScanCacheEntry,
  readGameCache,
  writeGameCache,
  scoutCacheProvenance,
  ENGINE_CACHE_MAX_ENTRIES,
  ENGINE_CACHE_MAX_BYTES,
  ENGINE_CACHE_TTL_MS,
  SCOUT_ENGINE_MIN_RECURRENCE,
  selectEngineScope,
} from "./scout-engine.js";

function makeAnalyzedScanRecord(gameId) {
  return {
    gameId,
    firstUci: "e2e4",
    firstSan: "e4",
    eligibleOpponentPlies: 2,
    analyzedOpponentPlies: 2,
    moves: [
      { ply: 0, cpLoss: 10, isInaccuracy: false },
      { ply: 2, cpLoss: 20, isInaccuracy: true },
    ],
  };
}

describe("scout-engine helpers", () => {
  it("does not convert a mate-only evaluation into a draw", () => {
    const result = classifyOpponentMove({ fenBefore: new Chess().fen(),
      playedUci: "e2e3", bestUci: "e2e4", beforeCp: null, beforeMate: 3,
      afterCp: 0, afterMate: null });
    expect(result.classification.label).toBe("Blunder");
    expect(result.cpLoss).toBe(1000);
  });

  it("preserves mate(0)'s signed cp from the shared classifier contract", () => {
    const result = classifyOpponentMove({ fenBefore: new Chess().fen(),
      playedUci: "e2e3", bestUci: "e2e4", beforeCp: 0, afterCp: -100000, afterMate: 0 });
    expect(result.classification.label).toBe("Blunder");
  });
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

  it("aggregates ACPL and first-inaccuracy ply by first-move family", () => {
    const agg = aggregateEngineByFamily([
      {
        gameId: "a",
        firstUci: "e2e4",
        firstSan: "e4",
        eligibleOpponentPlies: 2,
        analyzedOpponentPlies: 2,
        firstInaccuracyPly: 2,
        moves: [
          { ply: 0, cpLoss: 20, isInaccuracy: false },
          { ply: 2, cpLoss: 80, isInaccuracy: true },
        ],
      },
      {
        gameId: "b",
        firstUci: "e2e4",
        firstSan: "e4",
        eligibleOpponentPlies: 1,
        analyzedOpponentPlies: 1,
        firstInaccuracyPly: 4,
        moves: [{ ply: 4, cpLoss: 40, isInaccuracy: true }],
      },
      {
        gameId: "c",
        firstUci: "d2d4",
        firstSan: "d4",
        eligibleOpponentPlies: 1,
        analyzedOpponentPlies: 1,
        firstInaccuracyPly: null,
        moves: [{ ply: 1, cpLoss: 10, isInaccuracy: false }],
      },
    ]);
    expect(agg.families[0].san).toBe("e4");
    expect(agg.families[0].acpl).toBe(47);
    expect(agg.families[0].firstInaccuracyPly).toBe(3);
    expect(agg.analyzedGames).toBe(3);
    expect(agg.coveragePct).toBe(100);
    expect(agg.sufficient).toBe(true);
  });

  it("rejects incomplete legacy cache entries", () => {
    const replyMove = {
      ply: 0,
      cpLoss: 5,
      isInaccuracy: false,
      bestUci: "e2e4",
      opponentBestAlternativeUci: "e2e4",
      ourReplyUci: "c7c5",
      ourReplyPv: null,
    };
    expect(
      isCompleteScanCacheEntry({
        moves: [{ ply: 0, cpLoss: 80 }],
      }),
    ).toBe(false);
    expect(
      isCompleteScanCacheEntry({
        schemaVersion: ENGINE_CACHE_SCHEMA,
        record: {
          moves: [{ ply: 0, cpLoss: 80, isInaccuracy: true }],
          mistakes: [{ ply: 0, cpLoss: 80, isInaccuracy: true }],
          eligibleOpponentPlies: 1,
          analyzedOpponentPlies: 1,
        },
      }),
    ).toBe(false);
    expect(
      isCompleteScanCacheEntry({
        schemaVersion: ENGINE_CACHE_SCHEMA,
        record: {
          moves: [
            { ply: 0, cpLoss: 5, isInaccuracy: false },
            { ply: 2, cpLoss: 0, isInaccuracy: false },
          ],
          mistakes: [],
          eligibleOpponentPlies: 2,
          analyzedOpponentPlies: 2,
          complete: true,
        },
      }),
    ).toBe(false);
    expect(
      isCompleteScanCacheEntry({
        schemaVersion: ENGINE_CACHE_SCHEMA,
        record: {
          moves: [replyMove, { ...replyMove, ply: 2, ourReplyUci: null, ourReplyPv: ["e7e5"] }],
          mistakes: [],
          eligibleOpponentPlies: 2,
          analyzedOpponentPlies: 2,
          complete: true,
        },
      }),
    ).toBe(true);
  });

  it("rejects v2 cache records that predate reply fields", () => {
    const v2Record = {
      schemaVersion: 2,
      record: {
        moves: [{ ply: 0, cpLoss: 5, isInaccuracy: false, bestUci: "e2e4" }],
        mistakes: [],
        eligibleOpponentPlies: 1,
        analyzedOpponentPlies: 1,
        complete: true,
      },
    };
    expect(isCompleteScanCacheEntry(v2Record)).toBe(false);
  });


  it("accepts current caches only for the same input, engine and retention window", () => {
    const store = {
      data: {},
      getItem(key) {
        return this.data[key] ?? null;
      },
      setItem(key, value) {
        this.data[key] = value;
      },
      removeItem(key) {
        delete this.data[key];
      },
    };
    const depth = 12;
    const plies = 24;
    const key = `prepforge.scout.engine.v5:g1:d${depth}:p${plies}`;
    const game = { ucis: ["e2e4"], sans: ["e4"] };
    const provenance = scoutCacheProvenance(game, "white");
    const payload = {
      schemaVersion: ENGINE_CACHE_SCHEMA,
      at: Date.now(),
      provenance,
      record: {
        moves: [
          {
            ply: 0,
            cpLoss: 5,
            isInaccuracy: false,
            bestUci: "e2e4",
            opponentBestAlternativeUci: "e2e4",
            ourReplyUci: "c7c5",
            ourReplyPv: null,
          },
        ],
        mistakes: [],
        eligibleOpponentPlies: 1,
        analyzedOpponentPlies: 1,
        complete: true,
      },
    };
    store.setItem(key, JSON.stringify(payload));
    expect(readGameCache(store, "g1", depth, plies, provenance)).toEqual(payload);
    expect(readGameCache(store, "g1", depth, plies, scoutCacheProvenance(game, "black"))).toBeNull();
    expect(store.getItem(key)).toBeNull();
    expect(scoutCacheProvenance({ ...game, ucis: ["d2d4"] }, "white")).not.toBe(provenance);
    expect(scoutCacheProvenance({ ...game, sans: ["d4"] }, "white")).not.toBe(provenance);
    for (const at of [Date.now() - ENGINE_CACHE_TTL_MS - 1, Date.now() + 10000, undefined]) {
      store.setItem(key, JSON.stringify({ ...payload, at }));
      expect(readGameCache(store, "g1", depth, plies, provenance)).toBeNull();
    }
    store.setItem(key, JSON.stringify({ ...payload, record: { ...payload.record, eligibleOpponentPlies: 2 } }));
    expect(readGameCache(store, "g1", depth, plies, provenance)).toBeNull();
    expect(ENGINE_CACHE_SCHEMA).toBe(5);
  });

  it("bounds derived cache entries and bytes without pruning user data", () => {
    const data = new Map([["prepforge.sync.receipts", "keep"]]);
    const store = { get length() { return data.size; }, key: (i) => [...data.keys()][i],
      getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
      removeItem: (key) => data.delete(key) };
    const payload = { provenance: "test-engine/input", at: Date.now(), record: {
      moves: [], mistakes: [], eligibleOpponentPlies: 0, analyzedOpponentPlies: 0, complete: true,
    } };
    for (let i = 0; i < ENGINE_CACHE_MAX_ENTRIES + 5; i++) writeGameCache(store, `g${i}`, 12, 24, payload);
    expect(data.size).toBe(ENGINE_CACHE_MAX_ENTRIES + 1);
    expect(data.get("prepforge.sync.receipts")).toBe("keep");
    expect(readGameCache(store, "g0", 12, 24, payload.provenance)).toBeNull();
    for (let i = 0; i < 30; i++) writeGameCache(store, `large${i}`, 12, 24, { ...payload, padding: "x".repeat(100000) });
    const cacheBytes = [...data].filter(([key]) => key.startsWith("prepforge.scout.engine.v5:"))
      .reduce((sum, [, value]) => sum + value.length * 2, 0);
    expect(cacheBytes).toBeLessThanOrEqual(ENGINE_CACHE_MAX_BYTES);
    writeGameCache(store, "oversize", 12, 24, { ...payload, padding: "x".repeat(ENGINE_CACHE_MAX_BYTES) });
    expect(readGameCache(store, "oversize", 12, 24, payload.provenance)).toBeNull();
    expect(data.get("prepforge.sync.receipts")).toBe("keep");
  });

  it("selectEngineScope caps games to maxGames for color and speed", () => {
    const games = Array.from({ length: 61 }, (_, i) => ({
      gameId: `g${i}`,
      color: "white",
      speed: "blitz",
    }));
    const scope = selectEngineScope(games, { color: "white", speedFilter: "blitz", maxGames: 60 });
    expect(scope.gameIds).toHaveLength(60);
    expect(scope.gameIds[0]).toBe("g0");
    expect(scope.gameIds[59]).toBe("g59");
    expect(scope.totalGames).toBe(61);
    expect(scope.scopeLimited).toBe(true);
  });

  it("keeps a 60-game scan sufficient when extra games sit outside scope", () => {
    const gameIds = Array.from({ length: 60 }, (_, i) => `g${i}`);
    const records = gameIds.map(makeAnalyzedScanRecord);
    const agg = aggregateEngineByFamily(records, {
      eligibleGames: 60,
      eligibleGameIds: gameIds,
      scanGameIds: gameIds,
      scopeLimited: true,
      maxGames: 60,
    });
    expect(agg.stale).toBe(false);
    expect(agg.sufficient).toBe(true);
    expect(agg.status).toBe("ok");
    expect(agg.families.length).toBeGreaterThan(0);
  });

  it("marks aggregation stale only when the scoped game set changes", () => {
    const records = ["g1", "g2", "g3"].map(makeAnalyzedScanRecord);
    const unchanged = aggregateEngineByFamily(records, {
      eligibleGames: 3,
      eligibleGameIds: ["g1", "g2", "g3"],
      scanGameIds: ["g1", "g2", "g3"],
      scopeLimited: true,
      maxGames: 3,
    });
    expect(unchanged.stale).toBe(false);
    expect(unchanged.sufficient).toBe(true);

    const shifted = aggregateEngineByFamily(records, {
      eligibleGames: 3,
      eligibleGameIds: ["g0", "g1", "g2"],
      scanGameIds: ["g1", "g2", "g3"],
    });
    expect(shifted.stale).toBe(true);
    expect(shifted.sufficient).toBe(false);
    expect(shifted.status).toBe("stale");
    expect(shifted.families).toEqual([]);
  });

  it("marks aggregation insufficient below analyzed-game and coverage thresholds", () => {
    const agg = aggregateEngineByFamily([
      {
        gameId: "a",
        firstUci: "e2e4",
        firstSan: "e4",
        eligibleOpponentPlies: 2,
        analyzedOpponentPlies: 2,
        moves: [{ ply: 0, cpLoss: 30, isInaccuracy: true }],
      },
      {
        gameId: "b",
        firstUci: "d2d4",
        firstSan: "d4",
        eligibleOpponentPlies: 2,
        analyzedOpponentPlies: 0,
        moves: [],
      },
    ]);
    expect(agg.analyzedGames).toBe(1);
    expect(agg.coveragePct).toBe(50);
    expect(agg.sufficient).toBe(false);
    expect(agg.minAnalyzedGames).toBe(ENGINE_AGG_MIN_ANALYZED_GAMES);
    expect(agg.minCoveragePct).toBe(ENGINE_AGG_MIN_COVERAGE_PCT);
  });

  it("extracts trie patterns from legacy map or scan result object", () => {
    const map = new Map([["a", { playedSan: "Nf6" }]]);
    expect(engineScanPatterns(map)).toBe(map);
    expect(engineScanPatterns({ patterns: map })).toBe(map);
    expect(engineScanPatterns(null)).toBeNull();
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
