import { describe, expect, it, vi } from "vitest";

import { Chess } from "chess.js";

import {
  LUCKY_GAME_KEY,
  LUCKY_PHASE_KEY,
  LUCKY_SEED_FENS,
  START_FEN,
  buildMasterLine,
  luckyDbStart,
  nextLuckyPhase,
  pickPhaseCandidate,
  rememberLuckyGame,
  rememberLuckyPhase,
  sansFromPgn,
  sansFromTopGameMoves,
  scoreGamePositions,
  swingFromSnapshot,
  uciFen,
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

describe("uciFen", () => {
  it("converts one UCI to SAN with the resulting FEN", () => {
    const moved = uciFen(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "e2e4",
    );
    expect(moved.san).toBe("e4");
    expect(moved.fen).toContain(" b ");
    expect(moved.over).toBe(false);
  });

  it("returns null for an illegal move", () => {
    expect(
      uciFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "e2e5"),
    ).toBeNull();
  });
});

describe("buildMasterLine", () => {
  const FEN_AFTER_E4 =
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

  function lineStats(lines) {
    return vi.fn(async (db, fen) => {
      const placement = String(fen).split(" ")[0];
      const moves = lines[placement] || [];
      return { totalGames: moves.length, moves };
    });
  }

  it("walks the entry uci forward through live explorer replies", async () => {
    const fetchStats = lineStats({
      "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR": [
        { uci: "g1f3", total: 80 },
        { uci: "b1c3", total: 20 },
      ],
    });
    const line = await buildMasterLine({
      startFen: FEN_AFTER_E4,
      firstUci: "c7c5",
      fetchStats,
      rng: () => 0.01,
    });
    expect(line.sans.slice(0, 2)).toEqual(["c5", "Nf3"]);
    expect(line.sans.length).toBeGreaterThanOrEqual(2);
  });

  it("returns null when the entry uci is illegal here", async () => {
    const line = await buildMasterLine({
      startFen: FEN_AFTER_E4,
      firstUci: "e2e5",
      fetchStats: vi.fn(async () => ({ totalGames: 0, moves: [] })),
    });
    expect(line).toBeNull();
  });

  it("stops at a dry position instead of failing", async () => {
    const fetchStats = vi.fn(async () => ({ totalGames: 0, moves: [] }));
    const line = await buildMasterLine({
      startFen: FEN_AFTER_E4,
      firstUci: "e7e5",
      fetchStats,
    });
    expect(line.sans).toEqual(["e5"]);
  });
});

describe("luckyDbStart", () => {
  // Real upstream shape: ExplorerGameWithUciMove — ONE next-move uci plus a
  // game reference. There is deliberately no movetext and no PGN.
  // The mock explorer below is a small but REAL master tree: a fixed book of
  // Ruy Lopez plies with synthetic weights answers whatever side is to move
  // from any seed door, so every walk grows into a long, replayable, critical
  // line for every phase. Continuation replies always come from the tree.
  const TREE = null;
  void TREE;

  const BOOK_SANS = [
    "e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7",
    "Re1", "b5", "Bb3", "d6", "c3", "O-O", "h3", "Nb8", "d4", "Nbd7",
    "c4", "c6", "Nc3", "Bb7", "Bg5", "b4", "Nb1", "h6", "Bh4", "c5",
    "dxe5", "Nxe5", "Nxe5", "dxe5", "Qxd8", "Raxd8", "Rd1", "Rxd1+",
    "Bxd1", "Bxe4", "Bxf6", "Bxf6", "Rxe4", "Rxd2", "Rxe5", "Rd5",
    "Rxd5", "cxd5", "cxd5", "c4", "bxc4", "bxc4",
  ];

  function sanToUci(fen, san) {
    try {
      const probe = new Chess(fen);
      const move = probe.move(san);
      if (!move) return null;
      return `${move.from}${move.to}${move.promotion || ""}`;
    } catch (_) {
      return null;
    }
  }

  // Continuation replies for any walked position: the next still-unplayed
  // book ply that is legal there, with synthetic book weights. Never echoes
  // the caller's seed fixtures — always derived from the tree + chess.js.
  function replyMoves(fen) {
    const played = new Set();
    try {
      const probe = new Chess(START_FEN);
      for (const san of BOOK_SANS) {
        let move = null;
        try {
          move = probe.move(san);
        } catch (_) {
          move = null;
        }
        if (!move) break;
        played.add(`${move.from}${move.to}${move.promotion || ""}`);
        if (probe.fen() === fen) break;
      }
    } catch (_) {
      // probe is best-effort only
    }
    const replies = [];
    try {
      const legal = new Chess(fen).moves({ verbose: true });
      const seen = new Set();
      for (const san of BOOK_SANS) {
        if (replies.length >= 4) break;
        const uci = sanToUci(fen, san);
        if (!uci || seen.has(uci) || played.has(uci)) continue;
        const row = legal.find(
          (m) => `${m.from}${m.to}${m.promotion || ""}` === uci,
        );
        if (!row) continue;
        seen.add(uci);
        replies.push({ uci, san: row.san, total: 400 - replies.length * 60, share: 0.25 });
      }
      if (replies.length) return replies;
      return legal.slice(0, 4).map((m, i) => ({
        uci: `${m.from}${m.to}${m.promotion || ""}`,
        san: m.san,
        total: 400 - i * 60,
        share: 0.25,
      }));
    } catch (_) {
      return [];
    }
  }

  // Seed doors answer topGames with a real-shape entry whose uci is legal AT
  // THAT SEED: derived from the book by playing out plies until the seed is
  // reached, then offering the next legal book plies. Continuation positions
  // answer moves from the fixed book above.
  function walkStats() {
    return vi.fn(async (db, fen, opts) => {
      const wantsTop = opts && Number(opts.topGames) > 0;
      try {
        const probe = new Chess(START_FEN);
        let bookLeft = BOOK_SANS.slice();
        for (;;) {
          if (probe.fen() === fen) break;
          const san = bookLeft.shift();
          if (!san) break;
          let move = null;
          try {
            move = probe.move(san);
          } catch (_) {
            move = null;
          }
          if (!move) break;
        }
        if (probe.fen() === fen && bookLeft.length) {
          const entries = [];
          const seen = new Set();
          const atSeed = LUCKY_SEED_FENS.includes(fen);
          for (const san of bookLeft) {
            let move = null;
            try {
              move = probe.move(san);
            } catch (_) {
              move = null;
            }
            if (!move) continue;
            probe.undo();
            const uci = `${move.from}${move.to}${move.promotion || ""}`;
            if (seen.has(uci)) continue;
            seen.add(uci);
            entries.push({ id: `book-${uci}`, uci });
            if (entries.length >= (atSeed ? 2 : 0)) break;
            if (!atSeed) break;
          }
          if (wantsTop && entries.length && atSeed) {
            return {
              totalGames: 2000,
              moves: replyMoves(fen).slice(0, 2),
              topGames: entries,
            };
          }
        }
      } catch (_) {
        // fall through to the generic continuation below
      }
      return { totalGames: 2000, moves: replyMoves(fen), topGames: [] };
    });
  }

  it("walks a database-derived line from a real-shape seed (no PGN involved)", async () => {
    const fetchStats = walkStats();
    const storage = memoryStorage();
    const picked = await luckyDbStart({
      phase: "opening",
      storage,
      rng: () => 0,
      fetchStats,
    });
    expect(picked).not.toBeNull();
    expect(picked.reason).toBe("db-critical");
    expect(Array.isArray(picked.sans)).toBe(true);
    expect(picked.sans.length).toBeGreaterThanOrEqual(4);
    expect(picked.score).toBeGreaterThanOrEqual(5.0);
    expect(JSON.parse(storage.getItem(LUCKY_GAME_KEY) || "[]")).toContain(picked.gameId);
    // Production path, end to end: the winning line replays legally from the
    // seed the sampler walked (carried on the pick), exactly like the
    // sampler's verify gate. The picked FEN must sit ON that replayed line.
    expect(picked.seedFen).toBeTruthy();
    const replayed = verifyReplay(picked.sans, picked.seedFen);
    expect(replayed).not.toBeNull();
    expect(replayed.length).toBe(picked.sans.length + 1);
    expect(replayed.map((p) => p.fen)).toContain(picked.fen);
  });

  it("uses the seed FEN as the walk root, not the start position", async () => {
    const fetchStats = walkStats();
    const picked = await luckyDbStart({
      phase: "opening",
      storage: memoryStorage(),
      rng: () => 0,
      fetchStats,
    });
    const seedCall = fetchStats.mock.calls.find(
      (call) => call[2] && call[2].topGames === 4,
    );
    expect(seedCall[1]).not.toBe(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    );
  });

  it("returns a key position with phase and remembers the rotation", async () => {
    const storage = memoryStorage();
    const picked = await luckyDbStart({
      phase: "middlegame",
      storage,
      rng: () => 0,
      fetchStats: walkStats(),
    });
    expect(picked).not.toBeNull();
    expect(picked.reason).toBe("db-critical");
    expect(["opening", "middlegame", "endgame"]).toContain(picked.phase);
    expect(picked.fen).toContain(" ");
    expect(picked.gameId).toBeTruthy();
    expect(Array.isArray(picked.sans)).toBe(true);
    expect(picked.sans.length).toBeGreaterThanOrEqual(2);
    expect(storage.getItem(LUCKY_PHASE_KEY)).toBe(picked.phase);
    expect(JSON.parse(storage.getItem(LUCKY_GAME_KEY) || "[]")).toContain(picked.gameId);
  });

  it("prefers unseen games on repeat visits", async () => {
    const seenFen = LUCKY_SEED_FENS[0];
    const seenUci = sanToUci(START_FEN, BOOK_SANS[0]);
    const legalAtSeed = new Chess(seenFen).moves({ verbose: true });
    const freshUci = `${legalAtSeed[0].from}${legalAtSeed[0].to}${legalAtSeed[0].promotion || ""}`;
    expect(seenUci).toBeTruthy();
    expect(freshUci).toBeTruthy();
    expect(freshUci).not.toBe(seenUci);
    const tree = walkStats();
    const fetchStats = vi.fn(async (db, fen, opts) => {
      if (fen === seenFen && opts && Number(opts.topGames) > 0) {
        return {
          totalGames: 2000,
          moves: [],
          topGames: [
            { id: "seen-game", uci: seenUci },
            { id: "fresh-game", uci: freshUci },
          ],
        };
      }
      return tree(db, fen, opts);
    });
    const storage = memoryStorage();
    rememberLuckyGame("seen-game", storage);
    const picked = await luckyDbStart({
      phase: "opening",
      storage,
      rng: () => 0,
      fetchStats,
    });
    // Seen game is deprioritised: the walk starts from the fresh entry's uci.
    expect(picked).not.toBeNull();
    expect(picked.gameId).toBe("fresh-game");
  });

  it("drops entries whose uci is illegal at the seed", async () => {
    const fetchStats = vi.fn(async (db, fen) => {
      if (String(fen).startsWith("rnbqkbnr/pppp")) {
        return { topGames: [{ id: "broken", uci: "e2e5" }] };
      }
      return { totalGames: 0, moves: [] };
    });
    await expect(
      luckyDbStart({
        phase: "opening",
        storage: memoryStorage(),
        rng: () => 0,
        fetchStats,
      }),
    ).rejects.toThrow(/No sharp database game/);
  });

  it("skips a dry walk and tries the next entry", async () => {
    const seedFen = LUCKY_SEED_FENS[0];
    const legalAtSeed = new Chess(seedFen).moves({ verbose: true });
    const shortUci = `${legalAtSeed[0].from}${legalAtSeed[0].to}${legalAtSeed[0].promotion || ""}`;
    const goodUci = `${legalAtSeed[1].from}${legalAtSeed[1].to}${legalAtSeed[1].promotion || ""}`;
    const tree = walkStats();
    const fetchStats = vi.fn(async (db, fen, opts) => {
      if (fen === seedFen && opts && Number(opts.topGames) > 0) {
        return {
          totalGames: 0,
          moves: [],
          topGames: [
            { id: "too-short", uci: shortUci },
            { id: "good", uci: goodUci },
          ],
        };
      }
      if (opts && Number(opts.topGames) > 0) return tree(db, fen, opts);
      // The short entry's walk dies immediately (below the 4-ply floor) while
      // the good entry's walk grows through the book tree.
      try {
        const after = new Chess(seedFen);
        after.move({ from: shortUci.slice(0, 2), to: shortUci.slice(2, 4) });
        if (fen === after.fen()) return { totalGames: 0, moves: [] };
      } catch (_) {
        // fall through to the tree
      }
      return tree(db, fen, opts);
    });
    const picked = await luckyDbStart({
      phase: "opening",
      storage: memoryStorage(),
      rng: () => 0,
      fetchStats,
    });
    expect(picked).not.toBeNull();
    expect(picked.gameId).toBe("good");
  });

  it("throws a friendly error when every seed is empty", async () => {
    const fetchStats = vi.fn(async () => ({ topGames: [] }));
    await expect(
      luckyDbStart({
        storage: memoryStorage(),
        rng: () => 0,
        fetchStats,
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
      fetchStats: walkStats(),
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
    const picked = await luckyDbStart({
      phase: "opening",
      storage: memoryStorage(),
      rng: () => 0,
      fetchStats: walkStats(),
    });
    expect(picked.fen).toContain(" ");
  });
});
