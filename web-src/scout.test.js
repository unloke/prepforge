import { describe, expect, it, vi } from "vitest";

import {
  buildOpeningTrie,
  createScoutClient,
  gradeLines,
  lineCoverage,
  moveDistribution,
  movetextSans,
  parseGameBlock,
  parseMultiPgn,
  repertoireChildLookup,
  scoutUrl,
  topLines,
} from "./scout.js";

function pgn({ white = "Foe", black = "Other", result = "1-0", moves }) {
  return `[Event "Rated Blitz game"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n\n${moves} ${result}\n`;
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
  { color: "white", score: 1, sans: ["e4", "e5", "Nf3"], ucis: ["e2e4", "e7e5", "g1f3"] },
  { color: "white", score: 0, sans: ["e4", "c5", "Nf3"], ucis: ["e2e4", "c7c5", "g1f3"] },
  { color: "white", score: 1, sans: ["e4", "c5", "Nf3"], ucis: ["e2e4", "c7c5", "g1f3"] },
  { color: "white", score: 0.5, sans: ["d4", "d5"], ucis: ["d2d4", "d7d5"] },
  { color: "black", score: 1, sans: ["e4", "c5"], ucis: ["e2e4", "c7c5"] },
];

describe("buildOpeningTrie + distribution + topLines", () => {
  it("splits by colour and counts shares", () => {
    const trie = buildOpeningTrie(GAMES, "white");
    expect(trie.count).toBe(4);
    const dist = moveDistribution(trie);
    expect(dist[0]).toMatchObject({ san: "e4", count: 3 });
    expect(dist[0].share).toBeCloseTo(0.75);
    expect(dist[1]).toMatchObject({ san: "d4", count: 1 });
  });
  it("walks the most common continuation into a line per branch", () => {
    const trie = buildOpeningTrie(GAMES, "white");
    const lines = topLines(trie, { minCount: 1 });
    // e4 branch follows its most common reply (c5, 2 games).
    expect(lines[0].sans).toEqual(["e4", "c5", "Nf3"]);
    expect(lines[0].count).toBe(3);
    expect(lines[0].scorePct).toBe(67); // 2/3 from the e4 branch
    expect(lines[1].sans).toEqual(["d4", "d5"]);
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
