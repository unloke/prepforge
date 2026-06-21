import { describe, expect, it } from "vitest";

import { buildOpeningTrie, fenAfterLine } from "./scout.js";
import {
  OFF_BOOK_MAX_MASTERS_SHARE,
  THEORY_DEVIATION_MIN_GAP,
  THEORY_DEVIATION_MIN_GAMES,
  buildExplorerReads,
  classifyBookStatus,
  collectExplorerProbePositions,
  fetchExplorerReads,
  isAuthExplorerError,
  mastersShareForMove,
} from "./scout-explorer.js";

function game(overrides = {}) {
  return {
    color: "white",
    score: 1,
    sans: ["e4"],
    ucis: ["e2e4"],
    rating: 1800,
    opponentRating: 1750,
    datestamp: 1000,
    speed: "blitz",
    gameId: "g1",
    ...overrides,
  };
}

function mockMastersStats(moves, totalGames = 10_000) {
  const totalAll = totalGames;
  return {
    totalGames: totalAll,
    opening: "B20 Sicilian",
    moves: moves.map((m) => ({
      uci: m.uci,
      san: m.san,
      total: Math.round(totalAll * m.share),
      share: m.share,
      whitePct: 40,
      drawPct: 20,
      blackPct: 40,
    })),
  };
}

describe("classifyBookStatus", () => {
  it("labels off-book, low-popularity, and mainline at thresholds", () => {
    expect(classifyBookStatus(OFF_BOOK_MAX_MASTERS_SHARE - 0.01)).toBe("off-book");
    expect(classifyBookStatus(OFF_BOOK_MAX_MASTERS_SHARE + 0.01)).toBe("low-popularity");
    expect(classifyBookStatus(0.2)).toBe("mainline");
  });
});

describe("collectExplorerProbePositions", () => {
  it("collects first moves and replies under the top branch", () => {
    const games = [
      ...Array.from({ length: 5 }, (_, i) => game({ gameId: `e${i}` })),
      ...Array.from({ length: 2 }, (_, i) =>
        game({ sans: ["d4"], ucis: ["d2d4"], gameId: `d${i}` }),
      ),
      game({ sans: ["e4", "c5", "Nf3"], ucis: ["e2e4", "c7c5", "g1f3"], gameId: "sic" }),
    ];
    const trie = buildOpeningTrie(games, "white");
    const positions = collectExplorerProbePositions(trie, fenAfterLine, {
      maxFirstMoves: 2,
      maxReplies: 1,
    });
    expect(positions.some((p) => p.ply === 1 && p.moveSan === "e4")).toBe(true);
    expect(positions.some((p) => p.ply === 2 && p.moveSan === "c5")).toBe(true);
    expect(positions.every((p) => p.fen && p.opponentGames > 0)).toBe(true);
  });
});

describe("buildExplorerReads", () => {
  it("flags theory deviation when opponent share exceeds masters", () => {
    const startFen = fenAfterLine([]);
    const positions = [
      {
        fen: startFen,
        parentUcis: [],
        moveUci: "g1f3",
        moveSan: "Nf3",
        opponentShare: 0.4,
        opponentGames: THEORY_DEVIATION_MIN_GAMES,
        opponentScorePct: 60,
        ply: 1,
      },
    ];
    const masters = mockMastersStats([
      { uci: "e2e4", san: "e4", share: 0.45 },
      { uci: "g1f3", san: "Nf3", share: 0.1 },
    ]);
    const reads = buildExplorerReads(positions, {
      mastersByFen: new Map([[startFen, masters]]),
      poolByFen: new Map(),
    });
    expect(reads.theoryDeviation.available).toBe(true);
    expect(reads.theoryDeviation.items[0].moveSan).toBe("Nf3");
    expect(reads.theoryDeviation.items[0].gapPct).toBeGreaterThanOrEqual(
      Math.round(THEORY_DEVIATION_MIN_GAP * 100),
    );
  });

  it("excludes positions with insufficient masters sample", () => {
    const startFen = fenAfterLine([]);
    const positions = [
      {
        fen: startFen,
        parentUcis: [],
        moveUci: "e2e4",
        moveSan: "e4",
        opponentShare: 0.8,
        opponentGames: 5,
        opponentScorePct: 55,
        ply: 1,
      },
    ];
    const masters = mockMastersStats([{ uci: "e2e4", san: "e4", share: 0.4 }], 50);
    const reads = buildExplorerReads(positions, {
      mastersByFen: new Map([[startFen, masters]]),
    });
    expect(reads.theoryDeviation.available).toBe(false);
    expect(reads.theoryDeviation.excludedLowSample).toBe(1);
  });

  it("detects rare weapons with low masters share and strong results", () => {
    const startFen = fenAfterLine([]);
    const positions = [
      {
        fen: startFen,
        parentUcis: [],
        moveUci: "b1c3",
        moveSan: "Nc3",
        opponentShare: 0.25,
        opponentGames: 4,
        opponentScorePct: 70,
        ply: 1,
      },
    ];
    const masters = mockMastersStats([
      { uci: "e2e4", san: "e4", share: 0.5 },
      { uci: "b1c3", san: "Nc3", share: 0.02 },
    ]);
    const reads = buildExplorerReads(positions, {
      mastersByFen: new Map([[startFen, masters]]),
    });
    expect(reads.rareWeapons.available).toBe(true);
    expect(reads.rareWeapons.items[0].moveSan).toBe("Nc3");
  });

  it("marks off-book moves below the masters share floor", () => {
    const startFen = fenAfterLine([]);
    const positions = [
      {
        fen: startFen,
        parentUcis: [],
        moveUci: "g2g4",
        moveSan: "g4",
        opponentShare: 0.2,
        opponentGames: 3,
        opponentScorePct: 40,
        ply: 1,
      },
    ];
    const masters = mockMastersStats([{ uci: "g2g4", san: "g4", share: 0.01 }]);
    const reads = buildExplorerReads(positions, {
      mastersByFen: new Map([[startFen, masters]]),
    });
    expect(reads.offBook.available).toBe(true);
    expect(classifyBookStatus(mastersShareForMove(masters, "g2g4"))).toBe("off-book");
  });

  it("compares opponent share against the player pool", () => {
    const startFen = fenAfterLine([]);
    const positions = [
      {
        fen: startFen,
        parentUcis: [],
        moveUci: "d2d4",
        moveSan: "d4",
        opponentShare: 0.5,
        opponentGames: 4,
        opponentScorePct: 50,
        ply: 1,
      },
    ];
    const masters = mockMastersStats([
      { uci: "e2e4", san: "e4", share: 0.4 },
      { uci: "d2d4", san: "d4", share: 0.35 },
    ]);
    const pool = mockMastersStats([
      { uci: "e2e4", san: "e4", share: 0.45 },
      { uci: "d2d4", san: "d4", share: 0.2 },
    ]);
    const reads = buildExplorerReads(positions, {
      mastersByFen: new Map([[startFen, masters]]),
      poolByFen: new Map([[startFen, pool]]),
    });
    expect(reads.poolComparison.available).toBe(true);
    expect(reads.poolComparison.items[0].gapPct).toBeGreaterThanOrEqual(15);
  });
});

describe("fetchExplorerReads", () => {
  it("returns unavailable when auth fails", async () => {
    const fetchStats = async () => {
      throw new Error("link your Lichess account to use the opening explorer");
    };
    const out = await fetchExplorerReads({
      fetchStats,
      positions: [{ fen: "x", moveUci: "e2e4" }],
      opponentRating: 1800,
    });
    expect(out.available).toBe(false);
    expect(out.reason).toBe("auth");
    expect(isAuthExplorerError(new Error("link your Lichess account"))).toBe(true);
  });

  it("batches unique FENs through the client", async () => {
    const startFen = fenAfterLine([]);
    const calls = [];
    const fetchStats = async (db, fen) => {
      calls.push(`${db}:${fen}`);
      if (db === "masters") {
        return mockMastersStats([{ uci: "e2e4", san: "e4", share: 0.1 }]);
      }
      return mockMastersStats([{ uci: "e2e4", san: "e4", share: 0.08 }]);
    };
    const positions = [
      {
        fen: startFen,
        parentUcis: [],
        moveUci: "e2e4",
        moveSan: "e4",
        opponentShare: 0.6,
        opponentGames: 5,
        opponentScorePct: 55,
        ply: 1,
      },
      {
        fen: startFen,
        parentUcis: [],
        moveUci: "d2d4",
        moveSan: "d4",
        opponentShare: 0.2,
        opponentGames: 3,
        opponentScorePct: 45,
        ply: 1,
      },
    ];
    const out = await fetchExplorerReads({
      fetchStats,
      positions,
      opponentRating: 1800,
    });
    expect(out.available).toBe(true);
    expect(calls.filter((c) => c.startsWith("masters:")).length).toBe(1);
    expect(calls.filter((c) => c.startsWith("lichess:")).length).toBe(1);
    expect(out.mastersByFen).toBeInstanceOf(Map);
    expect(out.mastersByFen.get(startFen)?.totalGames).toBeGreaterThan(0);
    expect(out.poolByFen).toBeInstanceOf(Map);
    expect(out.poolByFen.get(startFen)?.totalGames).toBeGreaterThan(0);
  });

  it("still returns masters reads when pool fetch fails per-FEN", async () => {
    const startFen = fenAfterLine([]);
    const fetchStats = async (db) => {
      if (db === "masters") {
        return mockMastersStats([{ uci: "e2e4", san: "e4", share: 0.05 }]);
      }
      throw new Error("Explorer responded 503");
    };
    const out = await fetchExplorerReads({
      fetchStats,
      positions: [
        {
          fen: startFen,
          parentUcis: [],
          moveUci: "e2e4",
          moveSan: "e4",
          opponentShare: 0.7,
          opponentGames: 5,
          opponentScorePct: 60,
          ply: 1,
        },
      ],
      opponentRating: 1800,
    });
    expect(out.available).toBe(true);
    expect(out.poolComparison.available).toBe(false);
    expect(out.theoryDeviation.available).toBe(true);
  });
});