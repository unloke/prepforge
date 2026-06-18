import { describe, expect, it, vi } from "vitest";

import {
  buildOpeningTrie,
  createScoutClient,
  fenAfterLine,
  gradeLines,
  lineCoverage,
  moveDistribution,
  movetextSans,
  opponentProfile,
  parseGameBlock,
  parseMultiPgn,
  repertoireChildLookup,
  scoutUrl,
  topLines,
} from "./scout.js";

function pgn({
  white = "Foe",
  black = "Other",
  result = "1-0",
  moves,
  whiteElo = "",
  blackElo = "",
  utcDate = "",
  timeControl = "",
}) {
  const extras = [];
  if (whiteElo) extras.push(`[WhiteElo "${whiteElo}"]`);
  if (blackElo) extras.push(`[BlackElo "${blackElo}"]`);
  if (utcDate) extras.push(`[UTCDate "${utcDate}"]`);
  if (timeControl) extras.push(`[TimeControl "${timeControl}"]`);
  return `[Event "Rated Blitz game"]\n[White "${white}"]\n[Black "${black}"]\n${extras.join("\n")}${extras.length ? "\n" : ""}[Result "${result}"]\n\n${moves} ${result}\n`;
}

describe("movetextSans", () => {
  it("strips comments, clocks, numbers and results", () => {
    const sans = movetextSans(
      "1. e4 { [%clk 0:03:00] } e5 2. Nf3 $1 (2. f4 exf4) 2... Nc6 1-0",
    );
    expect(sans).toEqual(["e4", "e5", "Nf3", "Nc6"]);
  });
  it("caps at the requested ply depth", () => {
    expect(movetextSans("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6", 3)).toEqual(["e4", "e5", "Nf3"]);
  });
});

describe("parseGameBlock / parseMultiPgn", () => {
  it("extracts colour, score and replayed ucis for the scouted player", () => {
    const game = parseGameBlock(pgn({ moves: "1. e4 e5 2. Nf3" }), "foe");
    expect(game.color).toBe("white");
    expect(game.score).toBe(1);
    expect(game.ucis).toEqual(["e2e4", "e7e5", "g1f3"]);
  });
  it("scores from the scouted player's POV as black", () => {
    const game = parseGameBlock(
      pgn({ white: "Other", black: "Foe", result: "1-0", moves: "1. e4 c5" }),
      "foe",
    );
    expect(game.color).toBe("black");
    expect(game.score).toBe(0);
  });
  it("parses Elo, date, and speed bucket from headers", () => {
    const game = parseGameBlock(
      pgn({
        moves: "1. e4 e5",
        whiteElo: "1850",
        utcDate: "2026.06.10",
        timeControl: "180+2",
      }),
      "foe",
    );
    expect(game.rating).toBe(1850);
    expect(game.datestamp).toBeGreaterThan(0);
    expect(game.speed).toBe("blitz");
  });
  it("classifies speed buckets", () => {
    expect(
      parseGameBlock(pgn({ moves: "1. e4", timeControl: "60+0" }), "foe").speed,
    ).toBe("bullet");
    expect(
      parseGameBlock(pgn({ moves: "1. e4", timeControl: "600+0" }), "foe").speed,
    ).toBe("rapid");
    expect(
      parseGameBlock(pgn({ moves: "1. e4", timeControl: "1800+0" }), "foe").speed,
    ).toBe("classical");
    expect(parseGameBlock(pgn({ moves: "1. e4" }), "foe").speed).toBe("unknown");
  });
  it("skips games the player is not in, unfinished games, and junk", () => {
    expect(parseGameBlock(pgn({ moves: "1. e4" }), "someoneelse")).toBeNull();
    expect(parseGameBlock(pgn({ result: "*", moves: "1. e4" }), "foe")).toBeNull();
    const text = [
      pgn({ moves: "1. e4 e5" }),
      pgn({ white: "X", black: "Y", moves: "1. d4" }),
      pgn({ moves: "1. d4 d5" }),
    ].join("\n");
    expect(parseMultiPgn(text, "Foe")).toHaveLength(2);
  });
});

const GAMES = [
  {
    color: "white",
    score: 1,
    sans: ["e4", "e5", "Nf3"],
    ucis: ["e2e4", "e7e5", "g1f3"],
    rating: 1800,
    datestamp: 1000,
    speed: "blitz",
  },
  {
    color: "white",
    score: 0,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    rating: 1800,
    datestamp: 2000,
    speed: "blitz",
  },
  {
    color: "white",
    score: 1,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    rating: 1800,
    datestamp: 3000,
    speed: "rapid",
  },
  {
    color: "white",
    score: 0.5,
    sans: ["d4", "d5"],
    ucis: ["d2d4", "d7d5"],
    rating: 1800,
    datestamp: 4000,
    speed: "blitz",
  },
  {
    color: "black",
    score: 1,
    sans: ["e4", "c5"],
    ucis: ["e2e4", "c7c5"],
    rating: 1750,
    datestamp: 5000,
    speed: "blitz",
  },
];

describe("buildOpeningTrie + distribution + topLines", () => {
  it("splits by colour and counts shares", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    expect(trie.count).toBe(4);
    const dist = moveDistribution(trie);
    expect(dist[0]).toMatchObject({ san: "e4", count: 3 });
    expect(dist[0].share).toBeCloseTo(0.75);
    expect(dist[1]).toMatchObject({ san: "d4", count: 1 });
  });
  it("walks the most common continuation into a line per branch", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    const lines = topLines(trie, { minCount: 1 });
    // e4 branch follows its most common reply (c5, 2 games).
    expect(lines[0].sans).toEqual(["e4", "c5", "Nf3"]);
    expect(lines[0].count).toBe(3);
    expect(lines[0].scorePct).toBe(67); // 2/3 from the e4 branch
    expect(lines[1].sans).toEqual(["d4", "d5"]);
  });
  it("filters by speed", () => {
    const trie = buildOpeningTrie(GAMES, "white", { speedFilter: "rapid", recency: false });
    expect(trie.count).toBe(1);
  });
  it("defaults topLines limit to 12", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    const lines = topLines(trie, { minCount: 0.1 });
    expect(lines.length).toBeLessThanOrEqual(12);
  });
  it("attaches subLines to top 2 first-move branches", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    const lines = topLines(trie, { minCount: 1 });
    expect(lines[0].subLines).toBeDefined();
    expect(lines[0].subLines.length).toBeGreaterThan(0);
  });
  it("tracks raw gameCount separately from weighted count", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: true });
    expect(trie.gameCount).toBe(4);
    expect(trie.count).toBeGreaterThan(0);
    const lines = topLines(trie, { minCount: 1 });
    expect(lines[0].gameCount).toBe(3);
  });
  it("keeps weighted counts non-negative with mixed dated and undated games", () => {
    const mixed = [
      {
        color: "white",
        score: 1,
        sans: ["e4"],
        ucis: ["e2e4"],
        rating: 0,
        datestamp: 1_000,
        speed: "blitz",
      },
      {
        color: "white",
        score: 0,
        sans: ["e4"],
        ucis: ["e2e4"],
        rating: 0,
        datestamp: 0,
        speed: "blitz",
      },
      {
        color: "white",
        score: 1,
        sans: ["d4"],
        ucis: ["d2d4"],
        rating: 0,
        datestamp: 2_000,
        speed: "blitz",
      },
    ];
    const trie = buildOpeningTrie(mixed, "white", { recency: true });
    expect(trie.count).toBeGreaterThan(0);
    expect(trie.gameCount).toBe(3);
    for (const [, child] of trie.children) {
      expect(child.count).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("fenAfterLine", () => {
  it("returns FEN after replaying UCIs", () => {
    const fen = fenAfterLine(["e2e4", "c7c5", "g1f3"]);
    expect(fen).toMatch(/^rnbqkbnr\/pp1ppppp\/8\/2p5\/4P3\/5N2\//);
  });
});

describe("opponentProfile", () => {
  it("summarizes ratings and speed counts", () => {
    const profile = opponentProfile(GAMES);
    expect(profile.total).toBe(5);
    expect(profile.ratingMin).toBe(1750);
    expect(profile.ratingMax).toBe(1800);
    expect(profile.speedCounts.blitz).toBe(4);
    expect(profile.speedCounts.rapid).toBe(1);
  });
  it("detects recent opening changes when both windows have enough games", () => {
    const recent = Array.from({ length: 20 }, () => ({
      color: "white",
      ucis: ["d2d4"],
      rating: 0,
      speed: "blitz",
    }));
    const older = Array.from({ length: 20 }, () => ({
      color: "white",
      ucis: ["e2e4"],
      rating: 0,
      speed: "blitz",
    }));
    const profile = opponentProfile([...recent, ...older]);
    expect(profile.recentlyChanged.white).toBe(true);
  });
  it("does not flag recent change without a baseline window", () => {
    const recent = Array.from({ length: 4 }, () => ({
      color: "white",
      ucis: ["d2d4"],
      rating: 0,
      speed: "blitz",
    }));
    const older = [{ color: "white", ucis: ["e2e4"], rating: 0, speed: "blitz" }];
    const profile = opponentProfile([...recent, ...older]);
    expect(profile.recentlyChanged.white).toBe(false);
  });
});

describe("repertoire coverage", () => {
  // My black repertoire: root -> e4 (opp) -> c5 (mine) -> Nf3 (opp).
  const NODES = [
    { id: "root", depth: 0, parent_id: null, uci: null },
    { id: "n1", depth: 1, parent_id: "root", uci: "e2e4" },
    { id: "n2", depth: 2, parent_id: "n1", uci: "c7c5" },
    { id: "n3", depth: 3, parent_id: "n2", uci: "g1f3" },
  ];
  it("walks a line through the tree and reports depth + deepest node", () => {
    const lookup = repertoireChildLookup(NODES);
    expect(lineCoverage(lookup, ["e2e4", "c7c5", "g1f3"])).toEqual({
      covered: 3,
      deepestNodeId: "n3",
    });
    expect(lineCoverage(lookup, ["e2e4", "e7e5"])).toEqual({
      covered: 1,
      deepestNodeId: "n1",
    });
    expect(lineCoverage(lookup, ["d2d4"])).toEqual({ covered: 0, deepestNodeId: "root" });
  });
  it("grades short lines as prepared when fully followed", () => {
    const lookup = repertoireChildLookup(NODES);
    const graded = gradeLines(lookup, [
      { sans: ["e4", "c5", "Nf3"], ucis: ["e2e4", "c7c5", "g1f3"], count: 3 },
      { sans: ["d4"], ucis: ["d2d4"], count: 1 },
    ]);
    expect(graded[0].prepared).toBe(true); // full (short) line followed
    expect(graded[1].prepared).toBe(false);
    expect(graded[1].deepestNodeId).toBe("root");
  });
});

describe("createScoutClient", () => {
  const EXPORT = [pgn({ moves: "1. e4 e5" }), pgn({ moves: "1. d4 d5" })].join("\n");

  function memoryStorage() {
    const data = new Map();
    return {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => data.set(k, v),
    };
  }

  it("fetches the public export once, then serves the cache", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => EXPORT }));
    const client = createScoutClient({ fetchImpl, storage: memoryStorage() });
    const first = await client.fetchGames("Foe", { max: 60 });
    const second = await client.fetchGames("Foe", { max: 60 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it("maps 404 and 429 to friendly errors", async () => {
    const client404 = createScoutClient({
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }),
      storage: memoryStorage(),
    });
    await expect(client404.fetchGames("ghost")).rejects.toThrow(/no lichess user/i);
    const client429 = createScoutClient({
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => "" }),
      storage: memoryStorage(),
    });
    await expect(client429.fetchGames("foe")).rejects.toThrow(/rate limit/i);
  });

  it("builds a bounded export URL", () => {
    const url = scoutUrl("Foe", 9999);
    expect(url).toContain("/api/games/user/Foe?");
    expect(url).toContain("max=100");
    expect(url).toContain("perfType=blitz%2Crapid%2Cclassical");
  });
});