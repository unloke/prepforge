import { describe, expect, it, vi } from "vitest";

import {
  CURATED_GAMES,
  currentGameUrl,
  luckyTitledStart,
  playerTopUrl,
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

function dynamicHarness({
  feed = GAME_A,
  feedByPlayer = null,
  topUsers = [{ username: "AlphaGM", title: "GM", perfs: { blitz: { rating: 2800 } } }],
} = {}) {
  const fetchTopPlayers = vi.fn(async () => ({ users: topUsers }));
  const fetchPgn = vi.fn(async (username) => (feedByPlayer ? feedByPlayer[username] : feed));
  const fetchCurrentGamePgn = vi.fn(async () => feed);
  return { fetchTopPlayers, fetchPgn, fetchCurrentGamePgn };
}

describe("live Lichess endpoint URLs", () => {
  it("uses the documented recent-game feed filters", () => {
    const url = titledGamesUrl("nihalsarin", 4);
    expect(url).toContain("https://lichess.org/api/games/user/nihalsarin");
    expect(url).toContain("rated=true");
    expect(url).toContain("finished=true");
    expect(url).toContain("perfType=blitz%2Crapid%2Cclassical");
    expect(url).toContain("evals=true");
    expect(url).not.toContain("variant=");
  });

  it("exposes the dynamic leaderboard and current-game fallback paths", () => {
    expect(playerTopUrl(20, "blitz")).toBe("https://lichess.org/api/player/top/20/blitz");
    expect(currentGameUrl("AlphaGM")).toContain("https://lichess.org/api/user/AlphaGM/current-game");
    expect(singleGameUrl("kAdOQKeh")).toBe("https://lichess.org/game/export/kAdOQKeh");
  });
});

describe("splitPgnBlocks", () => {
  it("splits a multi-game response and reads complete headers", () => {
    const blocks = splitPgnBlocks(`${GAME_A}\n\n\n${GAME_B}\n`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('[GameId "rrdtEiYG"]');
    expect(blocks[1]).toContain('[GameId "kAdOQKeh"]');
  });

  it("returns [] for empty input", () => {
    expect(splitPgnBlocks("")).toEqual([]);
  });
});

describe("luckyTitledStart live selection", () => {
  it("discovers a player then locally selects from multiple fresh PGNs", async () => {
    const storage = memoryStorage();
    const h = dynamicHarness({ feed: `${GAME_A}\n\n${GAME_B}` });
    const picked = await luckyTitledStart({
      phase: "middlegame",
      storage,
      rng: () => 0.1,
      players: [],
      fetchTopPlayers: h.fetchTopPlayers,
      fetchPgn: h.fetchPgn,
      fetchCurrentGamePgn: h.fetchCurrentGamePgn,
      maxRequests: 2,
    });
    expect(picked).not.toBeNull();
    expect(picked.reason).toBe("titled-game");
    expect(picked.source).toBe("lichess-user-feed");
    expect(["rrdtEiYG", "kAdOQKeh"]).toContain(picked.gameId);
    expect(picked.sourceUrl).toContain("/api/games/user/AlphaGM");
    expect(h.fetchTopPlayers).toHaveBeenCalledTimes(1);
    expect(h.fetchPgn).toHaveBeenCalledTimes(1);
    expect(h.fetchPgn.mock.calls[0][0]).toBe("AlphaGM");
    expect(h.fetchCurrentGamePgn).not.toHaveBeenCalled();
  });

  it("uses another live player feed after a healthy but empty first feed", async () => {
    const h = dynamicHarness({
      topUsers: [],
      feedByPlayer: { First: "", Second: GAME_B },
    });
    const picked = await luckyTitledStart({
      storage: memoryStorage(),
      rng: () => 0.999,
      players: ["First", "Second"],
      discoverPlayers: false,
      fetchPgn: h.fetchPgn,
      fetchCurrentGamePgn: h.fetchCurrentGamePgn,
      maxRequests: 2,
      maxPlayersPerClick: 2,
      allowCurrentGame: false,
    });
    expect(picked?.gameId).toBe("kAdOQKeh");
    expect(h.fetchPgn).toHaveBeenCalledTimes(2);
  });

  it("spends the remaining bounded request on a second discovered player", async () => {
    const h = dynamicHarness({
      topUsers: [
        { username: "First", title: "GM", perfs: { blitz: { rating: 2800 } } },
        { username: "Second", title: "IM", perfs: { blitz: { rating: 2700 } } },
      ],
      feedByPlayer: { First: "", Second: GAME_B },
    });
    const picked = await luckyTitledStart({
      storage: memoryStorage(),
      rng: () => 0.999,
      fetchTopPlayers: h.fetchTopPlayers,
      fetchPgn: h.fetchPgn,
      maxRequests: 3,
      maxPlayersPerClick: 2,
      allowCurrentGame: false,
    });
    expect(picked?.gameId).toBe("kAdOQKeh");
    expect(h.fetchTopPlayers).toHaveBeenCalledTimes(1);
    expect(h.fetchPgn).toHaveBeenCalledTimes(2);
  });

  it("switches once to current/last game after a feed transport failure", async () => {
    const h = dynamicHarness({ feed: GAME_B });
    h.fetchPgn.mockRejectedValueOnce(Object.assign(new Error("Lichess rate limit"), { status: 429 }));
    const picked = await luckyTitledStart({
      storage: memoryStorage(),
      rng: () => 0.1,
      players: ["AlphaGM"],
      discoverPlayers: false,
      fetchPgn: h.fetchPgn,
      fetchCurrentGamePgn: h.fetchCurrentGamePgn,
      maxRequests: 2,
    });
    expect(picked?.source).toBe("lichess-current-game");
    expect(picked?.gameId).toBe("kAdOQKeh");
    expect(h.fetchPgn).toHaveBeenCalledTimes(1);
    expect(h.fetchCurrentGamePgn).toHaveBeenCalledTimes(1);
  });

  it("keeps the normal request budget bounded at discovery plus one feed", async () => {
    const h = dynamicHarness({ feed: GAME_A });
    const picked = await luckyTitledStart({
      storage: memoryStorage(),
      players: [],
      fetchTopPlayers: h.fetchTopPlayers,
      fetchPgn: h.fetchPgn,
      maxRequests: 2,
    });
    expect(picked).not.toBeNull();
    expect(h.fetchTopPlayers.mock.calls.length + h.fetchPgn.mock.calls.length).toBe(2);
    expect(h.fetchCurrentGamePgn).not.toHaveBeenCalled();
  });

  it("deduplicates a recently served live game", async () => {
    const storage = memoryStorage();
    const { rememberLuckyGame } = await import("./train-lucky-db.js");
    rememberLuckyGame("rrdtEiYG", storage);
    const h = dynamicHarness({ feed: GAME_A });
    await expect(
      luckyTitledStart({
        storage,
        players: [],
        fetchTopPlayers: h.fetchTopPlayers,
        fetchPgn: h.fetchPgn,
        allowCurrentGame: false,
        maxRequests: 2,
      }),
    ).rejects.toThrow(/No sharp titled game/);
  });

  it("rejects unfinished current games so every pick is replayable", async () => {
    const unfinished = GAME_A.replace('[Result "1-0"]', '[Result "*"]');
    const h = dynamicHarness({ feed: unfinished });
    h.fetchPgn.mockRejectedValueOnce(Object.assign(new Error("offline"), { status: 503 }));
    await expect(
      luckyTitledStart({
        storage: memoryStorage(),
        players: ["AlphaGM"],
        discoverPlayers: false,
        fetchPgn: h.fetchPgn,
        fetchCurrentGamePgn: vi.fn(async () => unfinished),
        maxRequests: 2,
      }),
    ).rejects.toThrow(/offline|503/);
  });

  it("does not consult fixed references unless explicitly enabled", async () => {
    const fetchSinglePgn = vi.fn(async () => GAME_A);
    await expect(
      luckyTitledStart({
        storage: memoryStorage(),
        players: [],
        discoverPlayers: false,
        fetchPgn: vi.fn(async () => ""),
        fetchSinglePgn,
        curatedGames: [{ id: "rrdtEiYG" }],
        allowCurrentGame: false,
        maxRequests: 1,
      }),
    ).rejects.toThrow(/No sharp titled game/);
    expect(fetchSinglePgn).not.toHaveBeenCalled();
  });

  it("keeps references available only for explicit emergency/test verification", async () => {
    const fetchSinglePgn = vi.fn(async () => GAME_A);
    const picked = await luckyTitledStart({
      storage: memoryStorage(),
      players: [],
      discoverPlayers: false,
      fetchPgn: vi.fn(async () => ""),
      fetchSinglePgn,
      curatedGames: [{ id: "rrdtEiYG" }],
      allowReferences: true,
      allowCurrentGame: false,
      maxRequests: 1,
    });
    expect(picked?.source).toBe("lichess-reference");
    expect(fetchSinglePgn).toHaveBeenCalledTimes(1);
  });

  it("skips variant games that cannot replay from START_FEN", async () => {
    const variant = GAME_A.replace('[Variant "Standard"]', '[Variant "Atomic"]');
    await expect(
      luckyTitledStart({
        storage: memoryStorage(),
        players: [],
        discoverPlayers: false,
        fetchPgn: vi.fn(async () => variant),
        allowCurrentGame: false,
        maxRequests: 1,
      }),
    ).rejects.toThrow(/No sharp titled game/);
  });

  it("returns a friendly no-quality error after all live feeds are empty", async () => {
    await expect(
      luckyTitledStart({
        storage: memoryStorage(),
        players: ["First", "Second"],
        discoverPlayers: false,
        fetchPgn: vi.fn(async () => ""),
        allowCurrentGame: false,
        maxRequests: 2,
        maxPlayersPerClick: 2,
      }),
    ).rejects.toThrow(/No sharp titled game/);
  });

  it("preserves explicit phase and a legal PGN-derived position", async () => {
    const h = dynamicHarness({ feed: GAME_A });
    const picked = await luckyTitledStart({
      phase: "middlegame",
      storage: memoryStorage(),
      players: [],
      fetchTopPlayers: h.fetchTopPlayers,
      fetchPgn: h.fetchPgn,
      maxRequests: 2,
    });
    expect(picked?.phase).toBe("middlegame");
    expect(picked?.fen).toContain(" ");
    expect(picked?.sans.length).toBeGreaterThanOrEqual(8);
    expect(picked?.score).toBeGreaterThanOrEqual(5);
  });

  it("ships only a small reference seam, not a production position pool", () => {
    expect(CURATED_GAMES.length).toBeGreaterThanOrEqual(3);
  });
});
