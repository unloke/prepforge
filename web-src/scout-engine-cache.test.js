import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ENGINE_CACHE_INDEX_KEY,
  engineCacheKey,
  readGameCache,
  writeGameCache,
} from "./scout-engine-cache.js";

function memoryStore(entries = []) {
  const data = new Map(entries);
  return { data, get length() { return data.size; }, key: (i) => [...data.keys()][i],
    getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
}

const move = (ply, isInaccuracy) => ({ ply, cpLoss: isInaccuracy ? 120 : 5, isInaccuracy, playedUci: "e2e4",
  opponentBestAlternativeUci: "d2d4", ourReplyUci: "e7e5", ourReplyPv: ["e7e5"] });

function payload(gameId, moves = [move(0, true), move(2, false)]) {
  return { provenance: "p", at: Date.now(), moves: moves.filter((m) => m.isInaccuracy), record: {
    gameId, moves, mistakes: moves.filter((m) => m.isInaccuracy),
    eligibleOpponentPlies: moves.length, analyzedOpponentPlies: moves.length, complete: true,
  } };
}

describe("deep scan cache", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stores mistakes once (inside moves) and rebuilds them on read", () => {
    const store = memoryStore();
    writeGameCache(store, "g1", 12, 24, payload("g1"));
    const stored = JSON.parse(store.getItem(engineCacheKey("g1", 12, 24)));
    expect(stored.moves).toBeUndefined();
    expect(stored.record.mistakes).toBeUndefined();
    const read = readGameCache(store, "g1", 12, 24, "p");
    expect(read.record.mistakes).toEqual([move(0, true)]);
    expect(read.record.moves).toHaveLength(2);
  });

  it("evicts from its index instead of parsing every other entry", () => {
    const store = memoryStore();
    for (let i = 0; i < 40; i++) writeGameCache(store, `g${i}`, 12, 24, payload(`g${i}`));
    const parse = vi.spyOn(JSON, "parse");
    writeGameCache(store, "late", 12, 24, payload("late"));
    expect(parse).toHaveBeenCalledTimes(1); // the index alone
    expect(Object.keys(JSON.parse(store.getItem(ENGINE_CACHE_INDEX_KEY)).entries)).toHaveLength(41);
  });

  it("drops older-version entries and rebuilds a lost index", () => {
    const store = memoryStore([
      ["prepforge.scout.engine.v5:old:d12:p24", "{}"],
      ["prepforge.sync.receipts", "keep"],
    ]);
    writeGameCache(store, "g1", 12, 24, payload("g1"));
    expect(store.getItem("prepforge.scout.engine.v5:old:d12:p24")).toBeNull();
    store.removeItem(ENGINE_CACHE_INDEX_KEY);
    writeGameCache(store, "g2", 12, 24, payload("g2"));
    expect(Object.keys(JSON.parse(store.getItem(ENGINE_CACHE_INDEX_KEY)).entries).sort())
      .toEqual([engineCacheKey("g1", 12, 24), engineCacheKey("g2", 12, 24)]);
    expect(store.getItem("prepforge.sync.receipts")).toBe("keep");
  });

  it("forgets an entry it rejects on read", () => {
    const store = memoryStore();
    writeGameCache(store, "g1", 12, 24, payload("g1"));
    expect(readGameCache(store, "g1", 12, 24, "other")).toBeNull();
    expect(JSON.parse(store.getItem(ENGINE_CACHE_INDEX_KEY)).entries).toEqual({});
  });
});
