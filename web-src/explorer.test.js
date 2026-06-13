import { describe, expect, it, vi } from "vitest";

import {
  ExplorerRateLimited,
  createExplorerClient,
  explorerUrl,
  formatGames,
  normalizeExplorer,
  ratingBucketsFor,
} from "./explorer.js";

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
  };
}

function okResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

const RAW = {
  white: 60,
  draws: 20,
  black: 20,
  opening: { eco: "B10", name: "Caro-Kann Defence" },
  moves: [
    { uci: "e2e4", san: "e4", white: 30, draws: 10, black: 10 },
    { uci: "d2d4", san: "d4", white: 30, draws: 10, black: 10 },
  ],
};

describe("ratingBucketsFor", () => {
  it("picks the nearest bucket plus a neighbour toward the rating", () => {
    expect(ratingBucketsFor(1740)).toEqual([1600, 1800]); // below 1800 -> span down
    expect(ratingBucketsFor(1850)).toEqual([1800, 2000]); // above 1800 -> span up
    expect(ratingBucketsFor(900)).toEqual([1000]); // low edge: single bucket
  });
  it("clamps at the ends and tolerates junk", () => {
    expect(ratingBucketsFor(3200)).toEqual([2500]);
    expect(ratingBucketsFor(undefined)).toEqual([1600, 1800]);
  });
});

describe("explorerUrl", () => {
  it("targets the authenticated proxy, masters with no pool params", () => {
    const url = explorerUrl("masters", FEN);
    expect(url).toMatch(/^\/api\/lichess\/explorer\/masters\?/);
    expect(url).not.toContain("ratings=");
  });
  it("builds a player-pool URL with rating buckets", () => {
    const url = explorerUrl("lichess", FEN, { rating: 1740 });
    expect(url).toMatch(/^\/api\/lichess\/explorer\/lichess\?/);
    expect(url).toContain("ratings=1600%2C1800");
  });
  it("changes the Players URL with rating but leaves Masters rating-independent", () => {
    const playersLow = explorerUrl("lichess", FEN, { rating: 1100 });
    const playersHigh = explorerUrl("lichess", FEN, { rating: 2300 });
    expect(playersLow).not.toBe(playersHigh); // pool tracks strength

    const mastersLow = explorerUrl("masters", FEN, { rating: 1100 });
    const mastersHigh = explorerUrl("masters", FEN, { rating: 2300 });
    expect(mastersLow).toBe(mastersHigh); // rating never enters the masters query
    expect(mastersLow).not.toContain("ratings=");
  });
});

describe("normalizeExplorer", () => {
  it("computes per-move percentages and overall share", () => {
    const stats = normalizeExplorer(RAW);
    expect(stats.totalGames).toBe(100);
    expect(stats.opening).toBe("B10 Caro-Kann Defence");
    expect(stats.moves[0]).toMatchObject({
      san: "e4",
      total: 50,
      share: 0.5,
      whitePct: 60,
      drawPct: 20,
      blackPct: 20,
    });
  });
  it("handles an empty position (no games)", () => {
    const stats = normalizeExplorer({ white: 0, draws: 0, black: 0, moves: [] });
    expect(stats.totalGames).toBe(0);
    expect(stats.moves).toEqual([]);
    expect(stats.opening).toBeNull();
  });
});

describe("formatGames", () => {
  it("abbreviates large counts", () => {
    expect(formatGames(532)).toBe("532");
    expect(formatGames(1532)).toBe("1.5k");
    expect(formatGames(15320)).toBe("15k");
    expect(formatGames(2_400_000)).toBe("2.4M");
  });
});

describe("createExplorerClient", () => {
  it("fetches once, then serves the cache", async () => {
    const fetchImpl = vi.fn(async () => okResponse(RAW));
    const client = createExplorerClient({ fetchImpl, storage: memoryStorage() });
    const first = await client.fetchStats("masters", FEN);
    const second = await client.fetchStats("masters", FEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("expires cache entries after the TTL", async () => {
    const fetchImpl = vi.fn(async () => okResponse(RAW));
    let t = 1_000;
    const client = createExplorerClient({
      fetchImpl,
      storage: memoryStorage(),
      now: () => t,
    });
    await client.fetchStats("masters", FEN);
    t += 8 * 24 * 60 * 60 * 1000; // > 7 day TTL
    await client.fetchStats("masters", FEN);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request for the same key", async () => {
    let resolve;
    const gate = new Promise((r) => (resolve = r));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return okResponse(RAW);
    });
    const client = createExplorerClient({ fetchImpl, storage: memoryStorage() });
    const a = client.fetchStats("masters", FEN);
    const b = client.fetchStats("masters", FEN);
    resolve();
    await Promise.all([a, b]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cools down after a 429 and fails fast meanwhile", async () => {
    let status = 429;
    const fetchImpl = vi.fn(async () => ({
      ok: status === 200,
      status,
      json: async () => RAW,
    }));
    let t = 0;
    const client = createExplorerClient({
      fetchImpl,
      storage: memoryStorage(),
      now: () => t,
    });
    await expect(client.fetchStats("masters", FEN)).rejects.toBeInstanceOf(
      ExplorerRateLimited,
    );
    // Within the cooldown no request is even attempted.
    status = 200;
    t = 30_000;
    await expect(client.fetchStats("masters", FEN)).rejects.toBeInstanceOf(
      ExplorerRateLimited,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // After the window it recovers.
    t = 61_000;
    const stats = await client.fetchStats("masters", FEN);
    expect(stats.totalGames).toBe(100);
  });

  it("evicts the oldest entries beyond the cap", async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () => okResponse(RAW));
    let t = 0;
    const client = createExplorerClient({ fetchImpl, storage, now: () => t });
    for (let i = 0; i < 160; i += 1) {
      t += 1;
      await client.fetchStats("masters", `${FEN}-${i}`);
    }
    const cache = JSON.parse(storage.getItem("prepforge.explorer.cache.v1"));
    const keys = Object.keys(cache.entries);
    expect(keys.length).toBeLessThanOrEqual(150);
    // The very first key fell off; the most recent stayed.
    expect(keys).not.toContain(explorerUrl("masters", `${FEN}-0`));
    expect(keys).toContain(explorerUrl("masters", `${FEN}-159`));
  });
});
