import { describe, expect, it, vi } from "vitest";

import {
  LUCKY_GAME_KEY,
  LUCKY_PHASE_KEY,
  luckyDbStart,
  nextLuckyPhase,
  pickPhaseCandidate,
  rememberLuckyGame,
  rememberLuckyPhase,
  sansFromPgn,
  sansFromTopGameMoves,
  scoreGamePositions,
  swingFromSnapshot,
  verifyReplay,
  walkSans,
} from "./train-lucky-db.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

const PGN_40 = `[Event "Rated Classical game"]
[Site "https://lichess.org/abcdef12"]
[White "WhitePlayer"]
[Black "BlackPlayer"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6
8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. c4 c6 12. Nc3 Bb7 13. Bg5 b4
14. Nb1 h6 15. Bh4 c5 16. dxe5 Nxe5 17. Nxe5 dxe5 18. Qxd8 Raxd8
19. Rd1 Rxd1+ 20. Bxd1 Bxe4 21. Bxf6 Bxf6 22. Rxe4 Rxd2 23. Rxe5 Rd5
24. Rxd5 cxd5 25. cxd5 c4 26. bxc4 bxc4 27. a4 c3 28. bxc3 bxc3 1-0`;

// Short queenless simplification that genuinely reaches structural endgame:
// queens off, few pieces, low non-pawn firepower.
const PGN_ENDGAME = `[Event "Endgame"]
[Site "https://lichess.org/endgame01"]
[White "WhitePlayer"]
[Black "BlackPlayer"]
[Result "1/2-1/2"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O Qd6 6. d4 exd4
7. Qxd4 Qxd4 8. Nxd4 Bd6 9. Nc3 Nf6 10. Bg5 O-O 11. Bxf6 gxf6
12. Nce2 Kh8 13. Ng3 Rg8 14. Nh5 Be5 15. c3 Bxd4 16. cxd4 f5
17. exf5 Bxf5 18. Rae1 Rg5 19. Re7 Rxd5 20. Rxc7 Rxd4 21. Rxb7 Rd2
22. Rxa6 Rxb2 23. Rxc6 Ra2 24. Rc8+ Rxc8 1/2-1/2`;

describe("sansFromPgn", () => {
  it("parses movetext and skips headers, numbers and results", () => {
    const sans = sansFromPgn(PGN_40);
    expect(sans.slice(0, 4)).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(sans.length).toBeGreaterThanOrEqual(38);
  });

  it("skips variations and keeps the main line", () => {
    expect(sansFromPgn("1. e4 (1. d4 d5) 1... e5 2. Nf3 *").slice(0, 3)).toEqual([
      "e4",
      "e5",
      "Nf3",
    ]);
  });

  it("stops cleanly at an illegal tail", () => {
    expect(sansFromPgn("1. e4 e5 9. Qqq *")).toEqual(["e4", "e5"]);
  });

  it("returns [] for empty input", () => {
    expect(sansFromPgn("")).toEqual([]);
  });
});

describe("sansFromTopGameMoves", () => {
  it("converts explorer UCI movetext to SAN", () => {
    expect(sansFromTopGameMoves("", "e2e4 e7e5 g1f3 b8c6")).toEqual([
      "e4",
      "e5",
      "Nf3",
      "Nc6",
    ]);
  });

  it("falls back to the PGN when the explorer list is unusable", () => {
    expect(sansFromTopGameMoves(PGN_40, "zzz e2e4").slice(0, 2)).toEqual(["e4", "e5"]);
    expect(sansFromTopGameMoves(PGN_40, "").slice(0, 2)).toEqual(["e4", "e5"]);
  });
});

describe("walkSans", () => {
  it("walks to per-ply FENs with ply numbers", () => {
    const positions = walkSans(["e4", "e5", "Nf3"]);
    expect(positions).toHaveLength(4);
    expect(positions[0].ply).toBe(0);
    expect(positions[3]).toMatchObject({ ply: 3, san: "Nf3" });
    expect(positions[3].fen.split(" ")[1]).toBe("b");
  });

  it("stops short on an illegal move", () => {
    expect(walkSans(["e4", "Qqq"])).toHaveLength(2);
  });
});

describe("scoreGamePositions", () => {
  it("covers opening and middlegame phases across a long game", () => {
    const positions = walkSans(sansFromPgn(PGN_40));
    const scored = scoreGamePositions(positions);
    const phases = new Set(scored.map((c) => c.phase));
    expect(phases.has("opening")).toBe(true);
    expect(phases.has("middlegame")).toBe(true);
  });

  it("reaches endgame on a simplified queenless tail", () => {
    const positions = walkSans(sansFromPgn(PGN_ENDGAME));
    const scored = scoreGamePositions(positions, { minPly: 2, maxPlyFromEnd: 0 });
    const phases = new Set(scored.map((c) => c.phase));
    expect(phases.has("endgame")).toBe(true);
  });

  it("skips the start and the last plies", () => {
    const positions = walkSans(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"]);
    const scored = scoreGamePositions(positions, { minPly: 2, maxPlyFromEnd: 2 });
    expect(scored.every((c) => c.position.ply >= 2)).toBe(true);
    expect(scored.at(-1).position.ply).toBeLessThan(positions.length - 1);
  });
});

describe("verifyReplay", () => {
  it("accepts a fully legal line and rejects a truncated tail", () => {
    const sans = sansFromPgn(PGN_40);
    const walked = verifyReplay(sans);
    expect(walked).not.toBeNull();
    expect(walked.length).toBe(sans.length + 1);
    expect(verifyReplay([...sans, "Qqq"])).toBeNull();
    expect(verifyReplay([])).not.toBeNull();
  });
});

describe("pickPhaseCandidate", () => {
  it("serves a critical moment in the target phase", () => {
    const positions = walkSans(sansFromPgn(PGN_40));
    const scored = scoreGamePositions(positions);
    const mid = pickPhaseCandidate(scored, "middlegame", { rng: () => 0 });
    expect(mid).not.toBeNull();
    expect(mid.phase).toBe("middlegame");
    expect(mid.score).toBeGreaterThanOrEqual(5.0);
  });

  it("honours excludes without leaving the phase when possible", () => {
    const positions = walkSans(sansFromPgn(PGN_40));
    const scored = scoreGamePositions(positions);
    const mid = pickPhaseCandidate(scored, "middlegame", { rng: () => 0 });
    const again = pickPhaseCandidate(scored, "middlegame", {
      rng: () => 0,
      exclude: [mid.position.fen],
    });
    expect(again).not.toBeNull();
    expect(again.position.fen).not.toBe(mid.position.fen);
  });

  it("keeps the critical gate by borrowing a neighbour phase first", () => {
    const positions = walkSans(sansFromPgn(PGN_40));
    const scored = scoreGamePositions(positions).map((c) =>
      c.phase === "endgame" ? { ...c, score: 0.5 } : c,
    );
    const picked = pickPhaseCandidate(scored, "endgame", { rng: () => 0 });
    expect(picked).not.toBeNull();
    expect(picked.score).toBeGreaterThanOrEqual(5.0);
  });

  it("returns null for an empty game", () => {
    expect(pickPhaseCandidate([], "opening")).toBeNull();
  });
});

describe("nextLuckyPhase / rememberLuckyPhase", () => {
  it("rotates opening -> middlegame -> endgame -> opening", () => {
    const storage = memoryStorage();
    storage.setItem(LUCKY_PHASE_KEY, "opening");
    expect(nextLuckyPhase({ storage })).toBe("middlegame");
    rememberLuckyPhase("middlegame", storage);
    expect(nextLuckyPhase({ storage })).toBe("endgame");
    rememberLuckyPhase("endgame", storage);
    expect(nextLuckyPhase({ storage })).toBe("opening");
  });

  it("picks a random phase when nothing is stored", () => {
    expect(nextLuckyPhase({ storage: memoryStorage(), rng: () => 0 })).toBe("opening");
    expect(nextLuckyPhase({ storage: memoryStorage(), rng: () => 0.5 })).toBe("middlegame");
    expect(nextLuckyPhase({ storage: memoryStorage(), rng: () => 0.99 })).toBe("endgame");
  });

  it("ignores junk storage values", () => {
    const storage = memoryStorage();
    storage.setItem(LUCKY_PHASE_KEY, "junk");
    expect(nextLuckyPhase({ storage, rng: () => 0 })).toBe("opening");
  });
});

describe("swingFromSnapshot", () => {
  it("reads best move and eval swing in pawns", () => {
    expect(
      swingFromSnapshot({
        pvs: [
          { pv_uci: ["e2e4"], score_cp: 60 },
          { pv_uci: ["d2d4"], score_cp: -40 },
        ],
      }),
    ).toEqual({ engineBest: "e2e4", swingPawns: 1 });
  });

  it("handles mates and single-line snapshots", () => {
    expect(
      swingFromSnapshot({ pvs: [{ pv_uci: ["e2e4"], mate_in: 3 }] }),
    ).toEqual({ engineBest: "e2e4" });
    expect(swingFromSnapshot({ pvs: [] })).toBeNull();
    expect(swingFromSnapshot(null)).toBeNull();
  });
});

describe("luckyDbStart", () => {
  const seedStats = {
    topGames: [
      {
        id: "game1",
        moves:
          "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 f1a4 g8f6 e1g1 f8e7 f1e1 b7b5 c1b3 d7d6 c2c3 e8g8 h2h3 f6b8 d2d4 b8d7 c2c4 c7c6 b1c3 c8b7 c1g5 b5b4 c3b1 h7h6 g5h4 c6c5 d4e5 d7e5 f3e5 d6e5 d1d8 a8d8 f1d1 d8d1 b1d1 c8e4 f1f6 e4f6 d1e4 d2d5 d5d4 c4d5 c7c4 b2c4 b4c4 a2a4 c4c3 b2c3 b3c3",
      },
      { id: "game2", moves: "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6" },
    ],
  };

  function harness({ pgn = PGN_40, candidateFen = null } = {}) {
    const calls = { stats: [], pgns: [] };
    const fetchStats = vi.fn(async (db, fen, opts) => {
      calls.stats.push([db, fen, opts]);
      if (String(fen).startsWith("rnbqkbnr/pppp")) return seedStats;
      // Strong book node: masters genuinely debated this position, so the
      // explorer bonus lifts the middlegame shortlist over the critical gate.
      return {
        totalGames: 2400,
        moves: [
          { uci: "e2e4", san: "e4", total: 700, share: 0.29 },
          { uci: "d2d4", san: "d4", total: 650, share: 0.27 },
          { uci: "c2c4", san: "c4", total: 550, share: 0.23 },
          { uci: "g1f3", san: "Nf3", total: 500, share: 0.21 },
        ],
      };
    });
    const fetchGamePgn = vi.fn(async (id) => {
      calls.pgns.push(id);
      // game1 replays from its own explorer movetext: the "real database game"
      // path — a full legal line that must verify end to end.
      if (id === "game1") return `[Event "Master game 1"]\n\n${PGN_40.split("\n").slice(5).join("\n")}`;
      return pgn;
    });
    return { calls, fetchStats, fetchGamePgn, candidateFen };
  }

  it("returns a key position with phase and remembers the rotation", async () => {
    const h = harness();
    const storage = memoryStorage();
    const picked = await luckyDbStart({
      phase: "middlegame",
      storage,
      rng: () => 0,
      fetchStats: h.fetchStats,
      fetchGamePgn: h.fetchGamePgn,
    });
    expect(picked).not.toBeNull();
    expect(picked.reason).toBe("db-critical");
    expect(["opening", "middlegame", "endgame"]).toContain(picked.phase);
    expect(picked.fen).toContain(" ");
    expect(picked.gameId).toBeTruthy();
    expect(Array.isArray(picked.sans)).toBe(true);
    expect(picked.sans.length).toBeGreaterThanOrEqual(4);
    expect(picked.score).toBeGreaterThanOrEqual(5.0);
    expect(storage.getItem(LUCKY_PHASE_KEY)).toBe(picked.phase);
    expect(JSON.parse(storage.getItem(LUCKY_GAME_KEY) || "[]")).toContain(picked.gameId);
    expect(h.calls.pgns.length).toBeGreaterThan(0);
    expect(["game1", "game2"]).toContain(h.calls.pgns[0]);
  });

  it("prefers unseen games on repeat visits", async () => {
    const h = harness();
    const storage = memoryStorage();
    rememberLuckyGame("game1", storage);
    const picked = await luckyDbStart({
      phase: "opening",
      storage,
      rng: () => 0,
      fetchStats: h.fetchStats,
      fetchGamePgn: h.fetchGamePgn,
    });
    expect(picked).not.toBeNull();
    expect(h.calls.pgns[0]).toBe("game2");
  });

  it("drops games whose SAN line does not fully replay", async () => {
    const h = harness({ pgn: "1. e4 e5 9. Qqq *" });
    h.fetchStats = vi.fn(async (db, fen) => {
      if (String(fen).startsWith("rnbqkbnr/pppp")) {
        return { topGames: [{ id: "broken", moves: "" }] };
      }
      return { totalGames: 0, moves: [] };
    });
    await expect(
      luckyDbStart({
        phase: "opening",
        storage: memoryStorage(),
        rng: () => 0,
        fetchStats: h.fetchStats,
        fetchGamePgn: h.fetchGamePgn,
      }),
    ).rejects.toThrow(/No sharp database game/);
  });

  it("skips games that fail to export and tries the next one", async () => {
    const h = harness();
    h.fetchGamePgn.mockRejectedValueOnce(new Error("nope"));
    const picked = await luckyDbStart({
      phase: "opening",
      storage: memoryStorage(),
      rng: () => 0,
      fetchStats: h.fetchStats,
      fetchGamePgn: h.fetchGamePgn,
    });
    expect(picked).not.toBeNull();
    expect(h.fetchGamePgn).toHaveBeenCalledTimes(2);
  });

  it("throws a friendly error when every seed is empty", async () => {
    const fetchStats = vi.fn(async () => ({ topGames: [] }));
    await expect(
      luckyDbStart({
        storage: memoryStorage(),
        rng: () => 0,
        fetchStats,
        fetchGamePgn: vi.fn(async () => PGN_40),
      }),
    ).rejects.toThrow(/No sharp database game/);
  });

  it("stops immediately on auth errors", async () => {
    const error = new Error("link your Lichess account");
    error.status = 400;
    const fetchStats = vi.fn(async () => {
      throw error;
    });
    await expect(
      luckyDbStart({ storage: memoryStorage(), fetchStats }),
    ).rejects.toThrow(/link your Lichess/);
    expect(fetchStats).toHaveBeenCalledTimes(1);
  });

  it("confirms the winner with engine swing + Maia when provided", async () => {
    const h = harness();
    const engine = {
      open: vi.fn(async () => {}),
      snapshot: vi.fn(() => ({
        running: false,
        pvs: [
          { pv_uci: ["e2e4"], score_cp: 120 },
          { pv_uci: ["d2d4"], score_cp: 20 },
        ],
      })),
      close: vi.fn(async () => {}),
    };
    const maia = { predictions: vi.fn(async () => [{ move_uci: "d2d4" }]) };
    const picked = await luckyDbStart({
      phase: "middlegame",
      storage: memoryStorage(),
      rng: () => 0,
      fetchStats: h.fetchStats,
      fetchGamePgn: h.fetchGamePgn,
      engine,
      maia,
      rating: 1500,
    });
    expect(engine.open).toHaveBeenCalled();
    expect(maia.predictions).toHaveBeenCalled();
    expect(picked.evidence.maiaTop).toBe("d2d4");
    expect(picked.evidence.swingPawns).toBeCloseTo(1, 5);
  });

  it("works with no engine and no Maia", async () => {
    const h = harness();
    const picked = await luckyDbStart({
      phase: "opening",
      storage: memoryStorage(),
      rng: () => 0,
      fetchStats: h.fetchStats,
      fetchGamePgn: h.fetchGamePgn,
    });
    expect(picked.fen).toContain(" ");
  });
});
