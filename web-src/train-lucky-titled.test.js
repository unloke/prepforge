import { describe, expect, it, vi } from "vitest";

import {
  CURATED_GAMES,
  luckyTitledStart,
  pgnHeader,
  singleGameUrl,
  splitPgnBlocks,
  titledGamesUrl,
} from "./train-lucky-titled.js";

const GAME_A = `[Event "rated blitz game"]
[Site "https://lichess.org/rrdtEiYG"]
[White "kim01"]
[Black "NihalSarin"]
[Result "1-0"]
[GameId "rrdtEiYG"]
[Variant "Standard"]

1. d4 c6 2. Nf3 d5 3. b3 Bf5 4. Bf4 Nf6 5. g3 e6 6. Bg2 Nbd7 7. O-O Be7 8. Nbd2 O-O 9. c4 h6 10. c5 b6 11. b4 a5 12. a3 Ne4 13. Qc1 axb4 14. axb4 b5 15. Nxe4 Bxe4 16. Ne5 Nxe5 17. Bxe5 Bxg2 18. Kxg2 f6 19. Bf4 g5 20. Be3 e5 21. h4 Kg7 22. hxg5 hxg5 23. dxe5 fxe5 24. Rh1 Rxa1 25. Qxa1 Rh8 26. Qxe5+ Bf6 27. Qe6 Rxh1 28. Kxh1 Qh8+ 29. Kg2 Qh5 30. Qd7+ Qf7 31. Qxc6 d4 32. Bd2 1-0`;

const GAME_B = `[Event "rated blitz game"]
[Site "https://lichess.org/kAdOQKeh"]
[White "respects_55"]
[Black "DrNykterstein"]
[Result "0-1"]
[GameId "kAdOQKeh"]
[Variant "Standard"]

1. e4 Nf6 2. e5 Nd5 3. Nc3 Nxc3 4. dxc3 d6 5. Nf3 Nc6 6. Bb5 a6 7. Bxc6+ bxc6 8. O-O f6 9. exf6 exf6 10. Nd4 Qd7 11. Qh5+ g6 12. Qf3 Kf7 13. Nxc6 Bb7 14. Nd8+ Rxd8 15. Qxb7 Qb5 16. Qxc7+ Rd7 17. c4 Rxb7 18. cxb5 Rxb5 0-1`;

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

describe("titledGamesUrl", () => {
  it("targets standard rated pools", () => {
    const url = titledGamesUrl("nihalsarin", 2);
    expect(url).toContain("https://lichess.org/api/games/user/nihalsarin");
    expect(url).toContain("rated=true");
    expect(url).toContain("variant=standard");
    expect(url).toContain("perfType=");
  });
});

describe("splitPgnBlocks / pgnHeader", () => {
  it("splits a multi-game response and reads tags", () => {
    const blocks = splitPgnBlocks(`${GAME_A}\n\n\n${GAME_B}\n`);
    expect(blocks).toHaveLength(2);
    expect(pgnHeader(blocks[0], "GameId")).toBe("rrdtEiYG");
    expect(pgnHeader(blocks[1], "White")).toBe("respects_55");
    expect(pgnHeader(blocks[0], "Missing")).toBeNull();
  });

  it("returns [] for empty input", () => {
    expect(splitPgnBlocks("")).toEqual([]);
  });
});

describe("luckyTitledStart", () => {
  function singleHarness(byId) {
    // Curated layer serves whatever ids the map holds; bulk layer is dead.
    const fetchSinglePgn = vi.fn(async (id) => {
      if (!(id in byId)) throw Object.assign(new Error("gone"), { status: 404 });
      return byId[id];
    });
    const fetchPgn = vi.fn(async () => {
      throw Object.assign(new Error("throttled"), { status: 429 });
    });
    return { fetchSinglePgn, fetchPgn };
  }

  it("serves the curated single-game layer first (no bulk fetch)", async () => {
    const { fetchSinglePgn, fetchPgn } = singleHarness({ rrdtEiYG: GAME_A });
    const picked = await luckyTitledStart({
      storage: memoryStorage(),
      rng: () => 0.1,
      curatedGames: [{ id: "rrdtEiYG" }],
      fetchSinglePgn,
      fetchPgn,
      retryDelayMs: 0,
    });
    expect(picked).not.toBeNull();
    expect(picked.reason).toBe("titled-game");
    expect(picked.gameId).toBe("rrdtEiYG");
    expect(fetchPgn).not.toHaveBeenCalled();
  });

  it("skips a dead curated id and serves the next one", async () => {
    const { fetchSinglePgn, fetchPgn } = singleHarness({ kAdOQKeh: GAME_B });
    const picked = await luckyTitledStart({
      storage: memoryStorage(),
      rng: () => 0.999,
      curatedGames: [{ id: "deadbeef" }, { id: "kAdOQKeh" }],
      fetchSinglePgn,
      fetchPgn,
      retryDelayMs: 0,
    });
    expect(picked).not.toBeNull();
    expect(picked.gameId).toBe("kAdOQKeh");
    expect(fetchSinglePgn).toHaveBeenCalledTimes(2);
  });

  it("ships a non-empty curated pool", () => {
    expect(CURATED_GAMES.length).toBeGreaterThanOrEqual(3);
    expect(singleGameUrl("kAdOQKeh")).toBe("https://lichess.org/game/export/kAdOQKeh");
  });

  it("skips variant games that cannot replay from the start", async () => {
    const variant = GAME_A.replace('[Variant "Standard"]', '[Variant "Atomic"]');
    const picked = await luckyTitledStart({
      storage: memoryStorage(),
      rng: () => 0.1,
      curatedGames: [{ id: "atomic1" }],
      fetchSinglePgn: vi.fn(async () => variant),
      fetchPgn: vi.fn(async () => {
        throw new Error("offline");
      }),
      retryDelayMs: 0,
    }).catch((error) => error);
    expect(picked).toBeInstanceOf(Error);
  });

  it("never re-serves a game the masters path just played", async () => {
    const store = memoryStorage();
    const { rememberLuckyGame } = await import("./train-lucky-db.js");
    rememberLuckyGame("rrdtEiYG", store);
    const picked = await luckyTitledStart({
      storage: store,
      rng: () => 0.1,
      // Only the banned game is available: must throw, not re-serve.
      curatedGames: [{ id: "rrdtEiYG" }],
      fetchSinglePgn: vi.fn(async () => GAME_A),
      fetchPgn: vi.fn(async () => {
        throw new Error("offline");
      }),
      retryDelayMs: 0,
    }).catch((error) => error);
    expect(picked).toBeInstanceOf(Error);
    expect(String(picked.message)).toMatch(/No sharp titled game/);
  });

  it("picks a critical legal position from real titled PGNs", async () => {
    const fetchPgn = vi.fn(async () => `${GAME_A}\n\n${GAME_B}\n`);
    const picked = await luckyTitledStart({
      storage: memoryStorage(),
      rng: () => 0.1,
      curatedGames: [],
      fetchPgn,
      retryDelayMs: 0,
    });
    expect(picked).not.toBeNull();
    expect(picked.reason).toBe("titled-game");
    expect(picked.fen).toContain(" ");
    expect(picked.gameId).toBeTruthy();
    expect(Array.isArray(picked.sans)).toBe(true);
    expect(picked.sans.length).toBeGreaterThanOrEqual(8);
    expect(picked.score).toBeGreaterThanOrEqual(5.0);
  });

  it("skips a dead bulk player and serves the next one", async () => {
    const seen = [];
    const fetchPgn = vi.fn(async (username) => {
      seen.push(username);
      if (seen.length === 1) throw Object.assign(new Error("nope"), { status: 404 });
      return GAME_B;
    });
    const picked = await luckyTitledStart({
      storage: memoryStorage(),
      rng: () => 0.999,
      curatedGames: [],
      players: ["GhostPlayer", "DrNykterstein"],
      fetchPgn,
      // No backoff in tests: the skip is instant.
      retryDelayMs: 0,
    });
    expect(picked).not.toBeNull();
    expect(picked.reason).toBe("titled-game");
    // First name in iteration order fails, second serves — regardless of
    // which name the shuffle puts first, both are attempted exactly once.
    expect(fetchPgn).toHaveBeenCalledTimes(2);
    expect(new Set(seen)).toEqual(new Set(["GhostPlayer", "DrNykterstein"]));
  });

  it("throws a friendly error when every layer fails", async () => {
    await expect(
      luckyTitledStart({
        storage: memoryStorage(),
        curatedGames: [],
        fetchPgn: vi.fn(async () => {
          throw new Error("offline");
        }),
        // No backoff in tests: the skip is instant.
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/No sharp titled game/);
  });

  it("throws a rate-limit error (not empty-result) when throttled", async () => {
    const err = Object.assign(new Error("Please only run 1 request(s) at a time"), { status: 429 });
    await expect(
      luckyTitledStart({
        storage: memoryStorage(),
        curatedGames: [],
        fetchPgn: vi.fn(async () => {
          throw err;
        }),
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/rate limit/);
  });

  it("honours an explicit phase", async () => {
    const fetchPgn = vi.fn(async () => GAME_A);
    const picked = await luckyTitledStart({
      phase: "middlegame",
      storage: memoryStorage(),
      rng: () => 0.5,
      curatedGames: [],
      players: ["nihalsarin"],
      fetchPgn,
      retryDelayMs: 0,
    });
    expect(picked).not.toBeNull();
    expect(picked.phase).toBe("middlegame");
  });
});
