import { describe, expect, it, vi } from "vitest";

import {
  ANALYZE_PLIES,
  MAX_PLIES,
  SCOUT_BRANCH_SCORE_CAP,
  SCOUT_RECENCY_HALF_LIFE_DAYS,
  aggregateOpeningBranches,
  branchExploitabilityPrior,
  branchPathKey,
  branchStruggle,
  buildOpeningTrie,
  createOpeningTrie,
  insertGameIntoTrie,
  trieAnchorTs,
  isEarlyResignCollapse,
  triePrefixStats,
  computeNextOwnThinkSeconds,
  gameNextOwnThinkMedian,
  createScoutClient,
  SCOUT_ERR_NETWORK,
  SCOUT_ERR_RATE_LIMIT,
  scoutFetchErrorMessage,
  fenAfterLine,
  fenBeforeLastMove,
  gradeLines,
  lineCoverage,
  moveDistribution,
  movetextSans,
  openingBreakdown,
  opponentProfile,
  parseClkToSeconds,
  parseGameBlock,
  parseGameFromJson,
  parseMainlineMoves,
  parseMultiPgn,
  parseNdjsonGames,
  parseTimeControlHeader,
  nodeIdAfterFlush,
  rankGamePlan,
  rankedOpeningBranches,
  recommendTargets,
  normalizeToOpponentTerminal,
  terminalMoveIsOpponent,
  triePathKey,
  wilsonScorePct,
  wilsonScoreUpperPct,
  repertoireChildLookup,
  suggestReplyFromRepertoire,
  attachPrepReplies,
  PGN_BLOCK_BOUNDARY,
  scoutStreamUrl,
  scoutUrl,
  topLines,
  WEAKNESS_MIN_GAMES,
} from "./scout.js";

function scoutGame({
  color = "white",
  score = 1,
  sans,
  ucis,
  rating = 1800,
  datestamp = 1000,
  speed = "blitz",
  gameId = null,
  clockAfterPly = null,
  timeControl = null,
  totalPly = null,
}) {
  const openingUcis = ucis;
  const openingSans = sans;
  return {
    color,
    score,
    sans,
    ucis,
    openingUcis,
    openingSans,
    openingEndPly: ucis.length,
    totalPly: totalPly ?? ucis.length,
    clockAfterPly: clockAfterPly ?? ucis.map(() => null),
    timeControl,
    nextOwnThinkSeconds: [],
    rating,
    opponentRating: 1800,
    datestamp,
    speed,
    gameId,
  };
}

function pgn({
  white = "Foe",
  black = "Other",
  result = "1-0",
  moves,
  whiteElo = "",
  blackElo = "",
  utcDate = "",
  timeControl = "",
  site = "",
}) {
  const extras = [];
  if (whiteElo) extras.push(`[WhiteElo "${whiteElo}"]`);
  if (blackElo) extras.push(`[BlackElo "${blackElo}"]`);
  if (utcDate) extras.push(`[UTCDate "${utcDate}"]`);
  if (timeControl) extras.push(`[TimeControl "${timeControl}"]`);
  if (site) extras.push(`[Site "${site}"]`);
  return `[Event "Rated Blitz game"]\n[White "${white}"]\n[Black "${black}"]\n${extras.join("\n")}${extras.length ? "\n" : ""}[Result "${result}"]\n\n${moves} ${result}\n`;
}

describe("movetextSans + clock parsing", () => {
  it("strips comments, clocks, numbers and results", () => {
    const sans = movetextSans(
      "1. e4 { [%clk 0:03:00] } e5 2. Nf3 $1 (2. f4 exf4) 2... Nc6 1-0",
    );
    expect(sans).toEqual(["e4", "e5", "Nf3", "Nc6"]);
  });
  it("caps at the requested ply depth", () => {
    expect(movetextSans("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6", 3)).toEqual(["e4", "e5", "Nf3"]);
  });
  it("parseMainlineMoves preserves [%clk] per move", () => {
    const moves = parseMainlineMoves("1. e4 { [%clk 0:03:00] } e5 { [%clk 0:02:58] }");
    expect(moves).toEqual([
      { san: "e4", clockSeconds: 180 },
      { san: "e5", clockSeconds: 178 },
    ]);
  });
  it("parseTimeControlHeader handles 180+2 and bare base", () => {
    expect(parseTimeControlHeader("180+2")).toEqual({
      baseSeconds: 180,
      incrementSeconds: 2,
    });
    expect(parseTimeControlHeader("180")).toEqual({
      baseSeconds: 180,
      incrementSeconds: 0,
    });
    expect(parseTimeControlHeader("")).toBeNull();
    expect(parseTimeControlHeader("daily")).toBeNull();
  });
  it("parseClkToSeconds converts H:MM:SS", () => {
    expect(parseClkToSeconds("0:03:00")).toBe(180);
    expect(parseClkToSeconds("0:03:01")).toBe(181);
  });
  it("computes next-own-think delta for black ...Nf6 then ...g6", () => {
    const clocks = [180, 180, 180, 181];
    const thinks = computeNextOwnThinkSeconds(clocks, 2, "black");
    expect(thinks[0]).toBe(1);
  });
  it("scoutUrl requests clocks=true", () => {
    expect(scoutUrl("Foe")).toContain("clocks=true");
    expect(scoutStreamUrl("Foe")).toContain("clocks=true");
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
  it("parses clocks, time control, and opening metadata from movetext", () => {
    const game = parseGameBlock(
      pgn({
        moves:
          "1. d4 { [%clk 0:03:00] } Nf6 { [%clk 0:03:00] } 2. e4 { [%clk 0:03:00] } g6 { [%clk 0:03:01] }",
        timeControl: "180+2",
        black: "Foe",
        white: "Rival",
        result: "0-1",
      }),
      "foe",
    );
    expect(game.timeControl).toEqual({ baseSeconds: 180, incrementSeconds: 2 });
    expect(game.clockAfterPly[1]).toBe(180);
    expect(game.clockAfterPly[3]).toBe(181);
    expect(game.totalPly).toBe(4);
    expect(game.openingUcis?.length).toBeGreaterThan(0);
    const thinks = computeNextOwnThinkSeconds(game.clockAfterPly, 2, "black");
    expect(thinks[0]).toBe(1);
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
  it("parses opponent Elo from the other side", () => {
    const asWhite = parseGameBlock(
      pgn({ moves: "1. e4 e5", whiteElo: "1800", blackElo: "1950" }),
      "foe",
    );
    expect(asWhite.rating).toBe(1800);
    expect(asWhite.opponentRating).toBe(1950);

    const asBlack = parseGameBlock(
      pgn({ white: "Other", black: "Foe", moves: "1. e4 e5", whiteElo: "2100", blackElo: "2000" }),
      "foe",
    );
    expect(asBlack.rating).toBe(2000);
    expect(asBlack.opponentRating).toBe(2100);
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
  it("keeps opening metadata as a contiguous legal prefix when phase detection flips back", () => {
    const game = parseGameBlock(
      pgn({
        white: "unbrainless87",
        black: "antek0011",
        result: "0-1",
        timeControl: "60+0",
        moves:
          "1. d4 Nf6 2. c4 e6 3. Nc3 b6 4. Nf3 Bb7 5. Bg5 h6 6. Bh4 g5 7. Bg3 Bg7 8. e3 d6 9. Be2 O-O 10. O-O Nbd7 11. d5 e5 12. e4 Nc5 13. Bd3 a5 14. a3 a4 15. h4 Nh5 16. hxg5 hxg5 17. Ne1 Nf4 18. Bxf4 exf4 19. Qg4 Bc8 20. Qf3 Qf6 21. Nc2 g4 22. Qd1 Qh4 23. Ne2 g3 24. fxg3 fxg3 25. Nxg3 Qxg3",
      }),
      "unbrainless87",
    );
    expect(game.openingEndPly).toBe(40);
    expect(game.openingSans.at(-1)).toBe("Qf6");
    expect(game.openingSans).not.toContain("Qd1");
    expect(game.openingUcis).toEqual(game.ucis.slice(0, game.openingEndPly));
    expect(game.openingSans).toEqual(game.sans.slice(0, game.openingEndPly));
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
  scoutGame({
    score: 1,
    sans: ["e4", "e5", "Nf3"],
    ucis: ["e2e4", "e7e5", "g1f3"],
    datestamp: 1000,
  }),
  scoutGame({
    score: 0,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    datestamp: 2000,
  }),
  scoutGame({
    score: 1,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    datestamp: 3000,
    speed: "rapid",
  }),
  scoutGame({
    score: 0.5,
    sans: ["d4", "d5"],
    ucis: ["d2d4", "d7d5"],
    datestamp: 4000,
  }),
  scoutGame({
    color: "black",
    score: 1,
    sans: ["e4", "c5"],
    ucis: ["e2e4", "c7c5"],
    rating: 1750,
    datestamp: 5000,
  }),
];

// Compare the quantities the report actually shows: gameCount (unweighted) and the
// recency-weighted score/count ratio. Both must match regardless of the recency anchor,
// which is what makes streaming-time incremental insertion (fixed anchor) equivalent to a
// one-shot rebuild (anchor = newest game).
function expectTrieDisplayEqual(a, b, path = "root") {
  expect(a.gameCount, `${path} gameCount`).toBe(b.gameCount);
  const ratioA = a.count ? a.score / a.count : 0;
  const ratioB = b.count ? b.score / b.count : 0;
  expect(ratioA, `${path} score/count`).toBeCloseTo(ratioB, 9);
  expect([...a.children.keys()].sort()).toEqual([...b.children.keys()].sort());
  for (const [key, childA] of a.children) {
    expectTrieDisplayEqual(childA, b.children.get(key), `${path}>${key}`);
  }
}

describe("incremental opening trie (streaming path)", () => {
  it("insertGameIntoTrie with the newest-game anchor reproduces buildOpeningTrie exactly", () => {
    const oneShot = buildOpeningTrie(GAMES, "white", { recency: true });
    const anchorTs = trieAnchorTs(GAMES); // buildOpeningTrie uses max datestamp over ALL games
    const incremental = createOpeningTrie();
    for (const g of GAMES) insertGameIntoTrie(incremental, g, "white", { anchorTs, recency: true });
    expect(incremental).toEqual(oneShot);
  });

  it("insert order does not change the trie", () => {
    const anchorTs = trieAnchorTs(GAMES);
    const forward = createOpeningTrie();
    for (const g of GAMES) insertGameIntoTrie(forward, g, "white", { anchorTs, recency: true });
    const reversed = createOpeningTrie();
    for (const g of [...GAMES].reverse()) insertGameIntoTrie(reversed, g, "white", { anchorTs, recency: true });
    expectTrieDisplayEqual(forward, reversed);
  });

  it("a fixed session anchor (unknowable newest game) still matches the displayed stats", () => {
    // Streaming inserts each game as it arrives, anchored to a fixed 'now' captured before
    // the newest game is known. Raw weights differ from the one-shot build by a constant,
    // but every displayed ratio/count is identical.
    const oneShot = buildOpeningTrie(GAMES, "white", { recency: true });
    const sessionNow = 9_999_999; // later than any game; not the per-set max
    const incremental = createOpeningTrie();
    for (const g of GAMES)
      insertGameIntoTrie(incremental, g, "white", { anchorTs: sessionNow, recency: true });
    expectTrieDisplayEqual(incremental, oneShot);
  });

  it("skips wrong-colour games and early-resign collapses like the batch build", () => {
    const anchorTs = trieAnchorTs(GAMES);
    const incremental = createOpeningTrie();
    for (const g of GAMES) insertGameIntoTrie(incremental, g, "black", { anchorTs, recency: true });
    expect(incremental).toEqual(buildOpeningTrie(GAMES, "black", { recency: true }));
  });
});

describe("buildOpeningTrie + distribution + topLines", () => {
  it("splits by colour and counts shares", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    expect(trie.count).toBe(4);
    const dist = moveDistribution(trie);
    expect(dist[0]).toMatchObject({ san: "e4", count: 3 });
    expect(dist[0].share).toBeCloseTo(0.75);
    expect(dist.find((m) => m.san === "d4")).toBeUndefined();
    const slipVisible = moveDistribution(trie, { slipMinGames: 0 });
    expect(slipVisible.find((m) => m.san === "d4")).toMatchObject({ san: "d4", count: 1 });
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
  it("tracks W/D/L counters per trie node", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    expect(trie.w).toBe(2);
    expect(trie.d).toBe(1);
    expect(trie.l).toBe(1);
    const dist = moveDistribution(trie);
    expect(dist[0].w + dist[0].d + dist[0].l).toBe(dist[0].gameCount);
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

describe("openingBreakdown + recommendTargets", () => {
  it("groups first-move families and deeper lines", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    const breakdown = openingBreakdown(trie, { minGames: 1 });
    expect(breakdown.some((g) => g.sans.length === 1 && g.sans[0] === "e4")).toBe(true);
    expect(breakdown.some((g) => g.sans.length >= 2)).toBe(true);
  });

  it("ranks frequent lines below the opponent baseline", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    const breakdown = openingBreakdown(trie, { minGames: 1 });
    const baseline = 50;
    const targets = recommendTargets(breakdown, baseline, {
      minGames: 2,
      limit: 5,
      oppColor: "white",
    });
    const attacks = targets.filter((t) => t.prepCategory === "attack");
    for (const t of attacks) {
      expect(t.games).toBeGreaterThanOrEqual(2);
      expect(t.wilsonScorePct).toBeLessThanOrEqual(baseline);
      expect(t.opportunity).toBeGreaterThan(0);
      expect(terminalMoveIsOpponent(t.ucis, "white")).toBe(true);
    }
  });

  it("wilsonScorePct returns neutral prior for empty samples", () => {
    expect(wilsonScorePct(0, 0, 0)).toBe(50);
    expect(wilsonScorePct(0, 0, 1)).toBeLessThan(wilsonScorePct(3, 2, 15));
  });

  it("classifies 6/7 wins as Main line against a 50% baseline (not Attack)", () => {
    const group = {
      line: "e2e4",
      sans: ["e4"],
      ucis: ["e2e4"],
      games: 7,
      w: 6,
      d: 0,
      l: 1,
      scorePct: 86,
      share: 0.5,
      count: 7,
    };
    const targets = recommendTargets([group], 50, { minGames: 7, oppColor: "white" });
    expect(targets).toHaveLength(1);
    expect(targets[0].prepCategory).toBe("weapon");
    expect(targets[0].prepCategory).not.toBe("attack");
    expect(wilsonScoreUpperPct(6, 0, 1)).toBeGreaterThanOrEqual(50);
  });

  it("leaves a line only marginally below baseline as neutral, not Attack", () => {
    // 36% vs a 38% baseline over a sample whose Wilson upper bound is well above
    // baseline — neither a punishable weakness nor a weapon, so: no badge, not a target.
    const group = {
      line: "e2e4",
      sans: ["e4"],
      ucis: ["e2e4"],
      games: 11,
      w: 4,
      d: 0,
      l: 7,
      scorePct: 36,
      share: 0.5,
      count: 11,
    };
    const targets = recommendTargets([group], 38, { minGames: 7, oppColor: "white" });
    expect(targets).toHaveLength(0);
  });

  it("collapses two lines that normalise to the same opponent-terminal move", () => {
    // "1.d4 Nf6" and "1.d4 g6" both end on the player's move, so both truncate to "1.d4".
    // They must surface as a single row, not two identical "When they play 1.d4" entries.
    const breakdown = [
      { line: "d2d4>g8f6", sans: ["d4", "Nf6"], ucis: ["d2d4", "g8f6"], games: 11, w: 3, d: 0, l: 8, scorePct: 26, share: 0.4, count: 11 },
      { line: "d2d4>g7g6", sans: ["d4", "g6"], ucis: ["d2d4", "g7g6"], games: 14, w: 10, d: 1, l: 3, scorePct: 75, share: 0.5, count: 14 },
    ];
    const targets = recommendTargets(breakdown, 38, { minGames: 7, oppColor: "white" });
    const d4Rows = targets.filter((t) => t.ucis.join(">") === "d2d4");
    expect(d4Rows).toHaveLength(1);
  });

  it("recommendTargets rejects lines ending on the player move", () => {
    const breakdown = [
      {
        line: "e2e4>c7c5>d2d4",
        sans: ["e4", "c5", "cxd4"],
        ucis: ["e2e4", "c7c5", "d2d4"],
        games: 10,
        w: 3,
        d: 1,
        l: 6,
        scorePct: 35,
        share: 0.4,
        count: 10,
      },
    ];
    const targets = recommendTargets(breakdown, 50, { minGames: 3, oppColor: "black" });
    expect(targets).toHaveLength(1);
    expect(targets[0].ucis).toEqual(["e2e4", "c7c5"]);
    expect(terminalMoveIsOpponent(targets[0].ucis, "black")).toBe(true);
  });

  it("normalizeToOpponentTerminal truncates player-terminal paths", () => {
    const out = normalizeToOpponentTerminal(["e2e4", "c7c5", "d2d4"], ["e4", "c5", "cxd4"], "black");
    expect(out?.ucis).toEqual(["e2e4", "c7c5"]);
  });

  it("excludes thin samples from recommendations", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    const breakdown = openingBreakdown(trie, { minGames: 1 });
    const targets = recommendTargets(breakdown, 40, { minGames: WEAKNESS_MIN_GAMES });
    expect(targets.every((t) => t.games >= WEAKNESS_MIN_GAMES)).toBe(true);
  });
});

describe("triePrefixStats + branchStruggle + exploitability prior", () => {
  function strugglingFamily() {
    // Black reaches 1...e5 five times and loses every time (family underperforms), with one
    // of those games continuing into a rare deeper reply.
    const shallow = Array.from({ length: 4 }, (_, i) =>
      scoutGame({
        color: "black",
        score: 0,
        sans: ["e4", "e5"],
        ucis: ["e2e4", "e7e5"],
        gameId: `e5-${i}`,
        datestamp: 1000 + i,
      }),
    );
    const deep = scoutGame({
      color: "black",
      score: 0,
      sans: ["e4", "e5", "Nf3", "Nge7"],
      ucis: ["e2e4", "e7e5", "g1f3", "g8e7"],
      gameId: "deep",
      datestamp: 2000,
    });
    return [...shallow, deep];
  }

  it("triePrefixStats returns per-ply nodes with game counts and move share", () => {
    const trie = buildOpeningTrie(strugglingFamily(), "black", { recency: false });
    const stats = triePrefixStats(trie, ["e2e4", "e7e5"]);
    expect(stats).toHaveLength(2);
    expect(stats[0].uci).toBe("e2e4");
    expect(stats[1].uci).toBe("e7e5");
    expect(stats[1].gameCount).toBe(5);
    // All five reaching the e4 node chose 1...e5, so the move share is 1.
    expect(stats[1].moveShare).toBeCloseTo(1, 5);
    expect(stats[1].scorePct).toBe(0); // lost all five
  });

  it("branchStruggle resolves an n=1 deep leaf at its n>=3 family prefix", () => {
    const trie = buildOpeningTrie(strugglingFamily(), "black", { recency: false });
    const deep = branchStruggle(trie, ["e2e4", "e7e5", "g1f3", "g8e7"], 50);
    expect(deep.prefixGames).toBe(5); // borrowed the family sample, not the n=1 leaf
    expect(deep.prefixPly).toBe(1);
    expect(deep.struggle).toBeGreaterThan(0); // family scores 0% vs a 50% baseline
  });

  it("branchStruggle reports no struggle when the family is at/above baseline", () => {
    const winning = Array.from({ length: 5 }, (_, i) =>
      scoutGame({
        color: "black",
        score: 1,
        sans: ["e4", "e5"],
        ucis: ["e2e4", "e7e5"],
        gameId: `win-${i}`,
        datestamp: 1000 + i,
      }),
    );
    const trie = buildOpeningTrie(winning, "black", { recency: false });
    expect(branchStruggle(trie, ["e2e4", "e7e5"], 50).struggle).toBe(0);
  });

  it("exploitability prior ranks a struggling line above a comfortable one", () => {
    const games = [
      ...strugglingFamily(),
      ...Array.from({ length: 6 }, (_, i) =>
        scoutGame({
          color: "black",
          score: 1, // comfortable: wins with the Caro
          sans: ["e4", "c6"],
          ucis: ["e2e4", "c7c6"],
          gameId: `caro-${i}`,
          datestamp: 1500 + i,
        }),
      ),
    ];
    const trie = buildOpeningTrie(games, "black", { recency: false });
    const struggling = branchExploitabilityPrior(
      { ucis: ["e2e4", "e7e5"], branchScore: 1 },
      { trie, baselineScorePct: 50 },
    );
    const comfortable = branchExploitabilityPrior(
      { ucis: ["e2e4", "c7c6"], branchScore: 1 },
      { trie, baselineScorePct: 50 },
    );
    expect(struggling).toBeGreaterThan(comfortable);
  });

  it("rankedOpeningBranches annotates struggle signals when a trie is supplied", () => {
    const games = strugglingFamily();
    const trie = buildOpeningTrie(games, "black", { recency: false });
    const { branches } = rankedOpeningBranches(games, "black", {
      trie,
      baselineScorePct: 50,
    });
    const e5 = branches.find((b) => b.ucis.join(">") === "e2e4>e7e5");
    expect(e5).toBeDefined();
    expect(e5.exploitabilityStruggle).toBeGreaterThan(0);
    expect(e5.prefixGames).toBeGreaterThanOrEqual(3);
    expect(typeof e5.exploitabilityPrior).toBe("number");
  });
});

describe("rankedOpeningBranches + rankGamePlan", () => {
  it("collects one real opening branch per game", () => {
    const { branches: lines } = rankedOpeningBranches(GAMES, "white");
    expect(lines.some((g) => g.sans[0] === "e4")).toBe(true);
    expect(lines.some((g) => g.sans[0] === "d4")).toBe(true);
    for (const line of lines) {
      expect(line.sans.length).toBeGreaterThan(0);
      expect(terminalMoveIsOpponent(line.ucis, "white")).toBe(true);
    }
  });

  it("keeps raw game counts while branchScore applies recency decay", () => {
    const old = Date.now() - 400 * 86_400_000;
    const games = [
      ...Array.from({ length: 20 }, (_, i) =>
        scoutGame({
          sans: ["e4", "c5"],
          ucis: ["e2e4", "c7c5"],
          datestamp: Date.now() - i * 86_400_000,
          gameId: `e${i}`,
        }),
      ),
      scoutGame({
        sans: ["d4", "d5"],
        ucis: ["d2d4", "d7d5"],
        datestamp: old,
        gameId: "d-old",
      }),
    ];
    const { branches: lines } = rankedOpeningBranches(games, "white");
    const d4 = lines.find((l) => l.ucis[0] === "d2d4");
    expect(d4).toBeDefined();
    expect(d4.games).toBe(1);
    expect(d4.branchScore).toBeGreaterThan(0);
    expect(d4.branchScore).toBeLessThan(0.5);
    expect(d4.rawShare).toBeCloseTo(1 / 21, 4);
  });

  it("With White keeps distinct d4 branches without prefix collapse", () => {
    const londonGames = [
      ...Array.from({ length: 10 }, (_, i) =>
        scoutGame({
          score: 0.5,
          sans: ["d4", "Nf6", "c4"],
          ucis: ["d2d4", "g8f6", "c2c4"],
          datestamp: 3000 - i,
          gameId: `nf6-${i}`,
        }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        scoutGame({
          score: 0,
          sans: ["d4", "d5", "c4"],
          ucis: ["d2d4", "d7d5", "c2c4"],
          datestamp: 2000 - i,
          gameId: `d5-${i}`,
        }),
      ),
    ];
    const { branches: lines } = rankedOpeningBranches(londonGames, "white");
    const nf6 = lines.find((l) => l.ucis.join(">") === "d2d4>g8f6>c2c4");
    const d5 = lines.find((l) => l.ucis.join(">") === "d2d4>d7d5>c2c4");
    expect(nf6).toBeDefined();
    expect(d5).toBeDefined();
    expect(terminalMoveIsOpponent(nf6.ucis, "white")).toBe(true);
    expect(terminalMoveIsOpponent(d5.ucis, "white")).toBe(true);
    expect(lines.find((l) => l.ucis.length === 1 && l.ucis[0] === "d2d4")).toBeUndefined();
  });

  it("With Black ends each branch on Black's actual opening move", () => {
    const games = [
      ...Array.from({ length: 6 }, (_, i) =>
        scoutGame({
          color: "black",
          score: 1,
          sans: ["e4", "c5"],
          ucis: ["e2e4", "c7c5"],
          datestamp: 1000 + i,
          gameId: `sic-${i}`,
        }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        scoutGame({
          color: "black",
          score: 0,
          sans: ["e4", "e5"],
          ucis: ["e2e4", "e7e5"],
          datestamp: 2000 + i,
          gameId: `kg-${i}`,
        }),
      ),
    ];
    const { branches: lines } = rankedOpeningBranches(games, "black");
    const sicilian = lines.find((l) => l.ucis.join(">") === "e2e4>c7c5");
    expect(sicilian).toBeDefined();
    expect(terminalMoveIsOpponent(sicilian.ucis, "black")).toBe(true);
    expect(sicilian.sans).toEqual(["e4", "c5"]);
  });

  it("branchPathKey preserves the full UCI path beyond MAX_PLIES", () => {
    const ucis = Array.from({ length: 20 }, (_, i) => `u${i}`);
    expect(branchPathKey(ucis)).toBe(ucis.join(">"));
    expect(branchPathKey(ucis).length).toBeGreaterThan(triePathKey(ucis).length);
  });

  it("builds ancestor-node frequencies from games reaching fenBefore", () => {
    const mainLineGames = Array.from({ length: 12 }, (_, i) =>
      scoutGame({
        color: "black",
        sans: ["e4", "c5", "Nf3", "Nc6"],
        ucis: ["e2e4", "c7c5", "g1f3", "b8c6"],
        gameId: `main-${i}`,
        datestamp: 1000 + i,
      }),
    );
    const sideline = scoutGame({
      color: "black",
      sans: ["e4", "c5", "Nf3", "a6"],
      ucis: ["e2e4", "c7c5", "g1f3", "a7a6"],
      gameId: "sideline",
      datestamp: 2000,
    });
    const { branches, ancestorFreq } = aggregateOpeningBranches(
      [...mainLineGames, sideline],
      "black",
    );
    expect(branches).toHaveLength(2);
    const sharedAncestor = fenBeforeLastMove(["e2e4", "c7c5", "g1f3", "b8c6"]);
    const sharedInfo = ancestorFreq.get(sharedAncestor);
    expect(sharedInfo?.count).toBe(13);
    expect(sharedInfo?.frequency).toBeCloseTo(1, 4);
    expect(sharedInfo?.games).toBe(13);
    expect(sharedInfo?.scorePct).toBe(100);
  });

  it("keeps distinct branches that share only the first MAX_PLIES", () => {
    const shared = Array.from({ length: 16 }, (_, i) => `p${i}`);
    const branchA = [...shared, "a16"];
    const branchB = [...shared, "b16"];
    const games = [
      scoutGame({
        sans: branchA,
        ucis: branchA,
        gameId: "a",
        datestamp: 2000,
      }),
      scoutGame({
        sans: branchB,
        ucis: branchB,
        gameId: "b",
        datestamp: 1000,
      }),
    ];
    const { branches } = aggregateOpeningBranches(games, "white");
    expect(branches).toHaveLength(2);
    expect(triePathKey(branchA)).toBe(triePathKey(branchB));
    expect(branches.map((b) => b.line).sort()).toEqual(
      [branchPathKey(branchA), branchPathKey(branchB)].sort(),
    );
  });

  it("gameNextOwnThinkMedian ignores clocks beyond openingEndPly", () => {
    const clocks = [180, 180, 180, 181, 5, 5, 5, 5, 5, 5];
    const openingOnly = gameNextOwnThinkMedian(
      {
        color: "black",
        openingEndPly: 4,
        clockAfterPly: clocks,
        timeControl: { baseSeconds: 180, incrementSeconds: 2 },
      },
      "black",
    );
    const fullGame = gameNextOwnThinkMedian(
      {
        color: "black",
        openingEndPly: clocks.length,
        clockAfterPly: clocks,
        timeControl: { baseSeconds: 180, incrementSeconds: 2 },
      },
      "black",
    );
    expect(openingOnly).toBe(1);
    expect(fullGame).toBeLessThan(5);
    expect(fullGame).toBeGreaterThan(openingOnly);
  });

  it("falls back to legacy ucis/sans when opening fields are absent", () => {
    const legacy = [
      {
        color: "white",
        score: 1,
        sans: ["e4", "c5", "Nf3"],
        ucis: ["e2e4", "c7c5", "g1f3"],
        datestamp: 1000,
        speed: "blitz",
        gameId: "legacy-1",
      },
      {
        color: "white",
        score: 0,
        sans: ["d4", "d5", "c4"],
        ucis: ["d2d4", "d7d5", "c2c4"],
        datestamp: 2000,
        speed: "blitz",
        gameId: "legacy-2",
      },
    ];
    const { branches } = rankedOpeningBranches(legacy, "white");
    expect(branches).toHaveLength(2);
    expect(branches.some((b) => b.ucis.join(">") === "e2e4>c7c5>g1f3")).toBe(true);
    expect(branches.some((b) => b.ucis.join(">") === "d2d4>d7d5>c2c4")).toBe(true);
  });

  it("caps candidate branches at SCOUT_BRANCH_SCORE_CAP", () => {
    const games = Array.from({ length: 60 }, (_, i) =>
      scoutGame({
        sans: [`m${i}`],
        ucis: [`u${i}`],
        gameId: `g${i}`,
        datestamp: i,
      }),
    );
    expect(rankedOpeningBranches(games, "white").branches).toHaveLength(SCOUT_BRANCH_SCORE_CAP);
  });

  it("ranks most-exploitable lines first and collapses nested prefixes", () => {
    const weak = {
      line: "e2e4>c7c5>g1f3",
      sans: ["e4", "c5", "Nf3"],
      ucis: ["e2e4", "c7c5", "g1f3"],
      games: 12,
      w: 2,
      d: 1,
      l: 9,
      scorePct: 21,
      share: 0.45,
      count: 12,
    };
    const strong = {
      line: "d2d4",
      sans: ["d4"],
      ucis: ["d2d4"],
      games: 10,
      w: 8,
      d: 0,
      l: 2,
      scorePct: 80,
      share: 0.35,
      count: 10,
    };
    const nested = {
      line: "e2e4",
      sans: ["e4"],
      ucis: ["e2e4"],
      games: 12,
      w: 2,
      d: 1,
      l: 9,
      scorePct: 21,
      share: 0.45,
      count: 12,
    };
    const ranked = rankGamePlan([strong, nested, weak], 50, { minGames: 7, oppColor: "white" });
    expect(ranked).toHaveLength(2);
    expect(ranked[0].ucis).toEqual(["e2e4", "c7c5", "g1f3"]);
    expect(ranked[0].opportunity).toBeGreaterThan(ranked[1].opportunity);
    expect(terminalMoveIsOpponent(ranked[0].ucis, "white")).toBe(true);
  });

  it("Maia exploitability beats Stockfish reproducibility when both lines have Maia", () => {
    const stockfishFavorite = {
      line: "e2e4>e7e5",
      sans: ["e4", "e5"],
      ucis: ["e2e4", "e7e5"],
      games: 20,
      w: 12,
      d: 2,
      l: 6,
      scorePct: 65,
      share: 0.4,
      count: 20,
      prefilterScore: 40,
      ancestorFrequency: 0.12,
      maiaScorePct: 58,
      maiaWdl: { win: 58, draw: 12, loss: 30 },
    };
    const maiaAttack = {
      line: "d2d4>d7d5",
      sans: ["d4", "d5"],
      ucis: ["d2d4", "d7d5"],
      games: 10,
      w: 3,
      d: 1,
      l: 6,
      scorePct: 35,
      share: 0.2,
      count: 10,
      prefilterScore: 20,
      ancestorFrequency: 0.05,
      maiaScorePct: 32,
      maiaWdl: { win: 32, draw: 10, loss: 58 },
    };
    const ranked = rankGamePlan([stockfishFavorite, maiaAttack], 50, { oppColor: "black" });
    expect(ranked[0].maiaScorePct).toBe(32);
    expect(ranked[1].maiaScorePct).toBe(58);
  });

  it("Maia-assessed lines rank before unenriched lines regardless of empirical opportunity", () => {
    // New design: rank by Maia3 opponent score (real data), not empirical opportunity
    // (100%/0% on n=1 is just noise — you can't lose more than 100% of one game).
    // A Maia weapon at 74% opponent score sorts BEFORE a no-Maia "attack" line.
    // Three unrelated first-move lines (White is opponent) — no prefix overlap, no dedup.
    const attackNoMaia = {
      line: "e2e4",
      sans: ["e4"],
      ucis: ["e2e4"],
      games: 1, w: 0, d: 0, l: 1, scorePct: 0, share: 0.15, count: 1,
    };
    const weaponWithMaia = {
      line: "d2d4",
      sans: ["d4"],
      ucis: ["d2d4"],
      games: 1, w: 1, d: 0, l: 0, scorePct: 100, share: 0.1, count: 1,
      maiaScorePct: 74, maiaWdl: { win: 74, draw: 13, loss: 13 },
    };
    const attackWithMaia = {
      line: "c2c4",
      sans: ["c4"],
      ucis: ["c2c4"],
      games: 1, w: 0, d: 0, l: 1, scorePct: 0, share: 0.1, count: 1,
      maiaScorePct: 28, maiaWdl: { win: 28, draw: 10, loss: 62 },
    };
    const ranked = rankGamePlan([weaponWithMaia, attackNoMaia, attackWithMaia], 50, {
      oppColor: "white",
    });
    // Maia attack (28%) beats Maia weapon (74%) — lower opp score = more exploitable.
    expect(ranked[0].maiaScorePct).toBe(28);
    // Maia weapon (74%) beats no-Maia line — real data beats noise.
    expect(ranked[1].maiaScorePct).toBe(74);
    // No-Maia line comes last.
    expect(ranked[2].maiaScorePct).toBeUndefined();
  });

  it("returns all qualifying lines without an artificial cap", () => {
    const lines = [
      {
        line: "e2e4",
        sans: ["e4"],
        ucis: ["e2e4"],
        games: 8,
        w: 2,
        d: 0,
        l: 6,
        scorePct: 25,
        share: 0.2,
        count: 8,
      },
      {
        line: "d2d4",
        sans: ["d4"],
        ucis: ["d2d4"],
        games: 9,
        w: 1,
        d: 0,
        l: 8,
        scorePct: 11,
        share: 0.18,
        count: 9,
      },
      {
        line: "g1f3",
        sans: ["Nf3"],
        ucis: ["g1f3"],
        games: 7,
        w: 3,
        d: 0,
        l: 4,
        scorePct: 43,
        share: 0.15,
        count: 7,
      },
    ];
    const ranked = rankGamePlan(lines, 55, { minGames: 7, oppColor: "white" });
    expect(ranked.length).toBeGreaterThanOrEqual(3);
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
  it("includes per-colour W/D/L and score baseline", () => {
    const profile = opponentProfile(GAMES);
    expect(profile.colorStats.white.games).toBe(4);
    expect(profile.colorStats.white.w + profile.colorStats.white.d + profile.colorStats.white.l).toBe(4);
    expect(profile.colorStats.white.scorePct).toBeGreaterThanOrEqual(0);
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

describe("nodeIdAfterFlush", () => {
  it("maps provisional tmp ids to reconciled server ids after flush", () => {
    const idMap = { "tmp-abc": "node-real-42" };
    expect(nodeIdAfterFlush("tmp-abc", idMap)).toBe("node-real-42");
    expect(nodeIdAfterFlush("node-existing", idMap)).toBe("node-existing");
    expect(nodeIdAfterFlush(null, idMap)).toBeNull();
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

  it("suggestReplyFromRepertoire picks enabled mainline over insertion order", () => {
    const nodes = [
      { id: "root", depth: 0, parent_id: null, uci: null },
      { id: "n1", depth: 1, parent_id: "root", uci: "e2e4" },
      { id: "n-alt", depth: 2, parent_id: "n1", uci: "b1c3", is_mainline: false, is_enabled: true },
      { id: "n-main", depth: 2, parent_id: "n1", uci: "g1f3", is_mainline: true, is_enabled: true },
    ];
    const lookup = repertoireChildLookup(nodes);
    expect(suggestReplyFromRepertoire(lookup, ["e2e4"])).toEqual({
      uci: "g1f3",
      source: "repertoire",
    });
  });

  it("attachPrepReplies writes the mainline reply for prep framing", () => {
    const nodes = [
      { id: "root", depth: 0, parent_id: null, uci: null },
      { id: "n1", depth: 1, parent_id: "root", uci: "e2e4" },
      { id: "n-alt", depth: 2, parent_id: "n1", uci: "b1c3", is_mainline: false, is_enabled: true },
      { id: "n-main", depth: 2, parent_id: "n1", uci: "g1f3", is_mainline: true, is_enabled: true },
    ];
    const lookup = repertoireChildLookup(nodes);
    const [target] = attachPrepReplies(
      [{ sans: ["e4"], ucis: ["e2e4"], games: 10, scorePct: 40, share: 0.5 }],
      { lookups: [{ lookup }], refutations: [], oppColor: "white" },
    );
    expect(target.suggestedReply).toMatchObject({ uci: "g1f3", source: "repertoire" });
  });

  it("suggestReplyFromRepertoire falls back to UCI order when no mainline is marked", () => {
    const nodes = [
      { id: "root", depth: 0, parent_id: null, uci: null },
      { id: "n1", depth: 1, parent_id: "root", uci: "e2e4" },
      { id: "n-b", depth: 2, parent_id: "n1", uci: "b1c3", is_mainline: false, is_enabled: true },
      { id: "n-g", depth: 2, parent_id: "n1", uci: "g1f3", is_mainline: false, is_enabled: true },
    ];
    const lookup = repertoireChildLookup(nodes);
    expect(suggestReplyFromRepertoire(lookup, ["e2e4"])).toEqual({
      uci: "b1c3",
      source: "repertoire",
    });
  });

  it("suggestReplyFromRepertoire skips disabled siblings for mainline selection", () => {
    const nodes = [
      { id: "root", depth: 0, parent_id: null, uci: null },
      { id: "n1", depth: 1, parent_id: "root", uci: "e2e4" },
      {
        id: "n-disabled-main",
        depth: 2,
        parent_id: "n1",
        uci: "b1c3",
        is_mainline: true,
        is_enabled: false,
      },
      { id: "n-enabled-alt", depth: 2, parent_id: "n1", uci: "g1f3", is_mainline: false, is_enabled: true },
    ];
    const lookup = repertoireChildLookup(nodes);
    expect(suggestReplyFromRepertoire(lookup, ["e2e4"])).toEqual({
      uci: "g1f3",
      source: "repertoire",
    });
  });

  it("suggestReplyFromRepertoire returns null when every sibling is disabled", () => {
    const nodes = [
      { id: "root", depth: 0, parent_id: null, uci: null },
      { id: "n1", depth: 1, parent_id: "root", uci: "e2e4" },
      { id: "n-alt", depth: 2, parent_id: "n1", uci: "b1c3", is_mainline: false, is_enabled: false },
      { id: "n-main", depth: 2, parent_id: "n1", uci: "g1f3", is_mainline: true, is_enabled: false },
    ];
    const lookup = repertoireChildLookup(nodes);
    expect(suggestReplyFromRepertoire(lookup, ["e2e4"])).toBeNull();
  });

  it("lineCoverage stops at a disabled node and does not mark the line prepared", () => {
    const nodes = [
      { id: "root", depth: 0, parent_id: null, uci: null },
      { id: "n1", depth: 1, parent_id: "root", uci: "e2e4" },
      { id: "n2", depth: 2, parent_id: "n1", uci: "c7c5", is_enabled: false },
      { id: "n3", depth: 3, parent_id: "n2", uci: "g1f3" },
    ];
    const lookup = repertoireChildLookup(nodes);
    expect(lineCoverage(lookup, ["e2e4", "c7c5", "g1f3"])).toEqual({
      covered: 1,
      deepestNodeId: "n1",
    });
    const [graded] = gradeLines(lookup, [
      { sans: ["e4", "c5", "Nf3"], ucis: ["e2e4", "c7c5", "g1f3"], count: 3 },
    ]);
    expect(graded.prepared).toBe(false);
    expect(graded.covered).toBe(1);
  });
});

describe("parseGameFromJson / parseNdjsonGames", () => {
  it("reuses the PGN reader and attaches centisecond clocks + the precise clock object", () => {
    const game = parseGameFromJson(
      {
        pgn: pgn({ moves: "1. e4 e5 2. Nf3 Nc6", white: "Foe", timeControl: "180+2" }),
        clocks: [18003, 17950, 17820, 17700],
        clock: { initial: 180, increment: 2, totalTime: 260 },
      },
      "Foe",
    );
    expect(game.ucis).toEqual(["e2e4", "e7e5", "g1f3", "b8c6"]);
    expect(game.clockCsAfterPly).toEqual([18003, 17950, 17820, 17700]);
    expect(game.clockInitialSeconds).toBe(180);
    expect(game.clockIncrementSeconds).toBe(2);
  });

  it("returns null without a usable pgn field", () => {
    expect(parseGameFromJson({ clocks: [1, 2] }, "Foe")).toBeNull();
  });

  it("parses one game per line and tolerates blanks and garbage", () => {
    const text = [
      JSON.stringify({ pgn: pgn({ moves: "1. e4 e5", white: "Foe" }), clocks: [18000, 17900] }),
      "",
      "not json",
      JSON.stringify({ pgn: pgn({ moves: "1. d4 d5", white: "Foe" }) }),
    ].join("\n");
    const games = parseNdjsonGames(text, "Foe");
    expect(games).toHaveLength(2);
    expect(games[0].clockCsAfterPly).toEqual([18000, 17900]);
  });

  it("adds pgnInJson to the export URL only when requested", () => {
    expect(scoutUrl("Foe", null, { pgnInJson: true })).toContain("pgnInJson=true");
    expect(scoutUrl("Foe")).not.toContain("pgnInJson");
  });
});

describe("isEarlyResignCollapse (opening-collapse down-weight)", () => {
  // White resigns on move 3 holding ~91% of a 180s clock: the textbook one-off collapse.
  const base = {
    color: "white",
    score: 0,
    status: "resign",
    totalPly: 6,
    clockInitialSeconds: 180,
    clockAfterPly: [175, 178, 172, 176, 165, 174], // White = even indices; last own = 165s
  };

  it("flags a lost, early resignation made with a healthy clock", () => {
    expect(isEarlyResignCollapse(base)).toBe(true);
  });

  it("keeps games the opponent did not lose", () => {
    expect(isEarlyResignCollapse({ ...base, score: 1 })).toBe(false);
    expect(isEarlyResignCollapse({ ...base, score: 0.5 })).toBe(false);
  });

  it("keeps checkmates and time forfeits — only resignations count", () => {
    expect(isEarlyResignCollapse({ ...base, status: "mate" })).toBe(false);
    expect(isEarlyResignCollapse({ ...base, status: "outoftime" })).toBe(false);
  });

  it("keeps long games (a played-out line, not a snap collapse)", () => {
    expect(isEarlyResignCollapse({ ...base, totalPly: 40 })).toBe(false);
  });

  it("keeps resignations made in a time scramble (little clock left)", () => {
    // White's last own reading (index 4) is 4s of 180 → ~2%, well below the healthy floor.
    expect(isEarlyResignCollapse({ ...base, clockAfterPly: [40, 178, 20, 176, 4, 174] })).toBe(false);
  });

  it("abstains when the clock can't be read", () => {
    expect(
      isEarlyResignCollapse({ ...base, clockAfterPly: [], clockInitialSeconds: undefined, timeControl: null }),
    ).toBe(false);
  });

  it("reads Black's clock at odd plies, in centiseconds, and via timeControl.baseSeconds", () => {
    const g = {
      color: "black",
      score: 0,
      status: "resign",
      totalPly: 5,
      timeControl: { baseSeconds: 300, incrementSeconds: 0 },
      clockCsAfterPly: [29500, 28000, 29000, 27000, 28500], // Black = odd; last own (idx 3) = 270s
    };
    expect(isEarlyResignCollapse(g)).toBe(true);
  });
});

describe("buildOpeningTrie / aggregateOpeningBranches collapse exclusion", () => {
  const line = (over) => ({
    color: "white",
    speed: "blitz",
    sans: ["e4", "e5", "Nf3"],
    ucis: ["e2e4", "e7e5", "g1f3"],
    totalPly: 3,
    ...over,
  });
  const collapse = line({
    score: 0,
    status: "resign",
    clockInitialSeconds: 180,
    clockAfterPly: [176, 178, 170],
  });
  const realLoss = line({
    score: 0,
    status: "mate", // mated in the opening: a repeatable trap, kept
    clockInitialSeconds: 180,
    clockAfterPly: [60, 55, 40],
  });

  it("drops an early-resign collapse from the trie so it can't inflate struggle", () => {
    const trie = buildOpeningTrie([collapse, realLoss], "white");
    expect(trie.gameCount).toBe(1); // collapse excluded, mate kept
    const e4 = [...trie.children.values()][0];
    expect(e4.l).toBe(1); // exactly one counted loss (the mate), not two
  });

  it("keeps the collapse when excludeCollapse:false", () => {
    const trie = buildOpeningTrie([collapse, realLoss], "white", { excludeCollapse: false });
    expect(trie.gameCount).toBe(2);
  });

  it("also drops the collapse from branch aggregation", () => {
    const { branches } = aggregateOpeningBranches([collapse, realLoss], "white");
    const totalGames = branches.reduce((s, b) => s + b.games, 0);
    expect(totalGames).toBe(1);
  });
});

describe("createScoutClient", () => {
  // fetchGames now uses the ND-JSON export (pgnInJson) so it can read centisecond clocks.
  const ndjson = (objs) => objs.map((o) => JSON.stringify(o)).join("\n");
  const EXPORT = ndjson([
    { pgn: pgn({ moves: "1. e4 e5" }) },
    { pgn: pgn({ moves: "1. d4 d5" }) },
  ]);

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

  it("ignores a stale v3 cache entry (bullet-contaminated) and re-fetches", async () => {
    // The v3 cache could hold pre-excludeBullet results; the v4 key must not read it.
    const storage = memoryStorage();
    storage.setItem(
      "prepforge.scout.cache.v3",
      JSON.stringify({ entries: { "foe:60": { at: Date.now(), games: [{ stale: true }] } } }),
    );
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => EXPORT }));
    const client = createScoutClient({ fetchImpl, storage });
    const games = await client.fetchGames("Foe", { max: 60 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(games).toHaveLength(2);
    expect(games).not.toContainEqual({ stale: true });
  });

  it("fetchGames omits max from the export URL by default", async () => {
    let fetchedUrl = "";
    const fetchImpl = vi.fn(async (url) => {
      fetchedUrl = String(url);
      return { ok: true, status: 200, text: async () => EXPORT };
    });
    const client = createScoutClient({ fetchImpl, storage: memoryStorage() });
    await client.fetchGames("Foe");
    expect(fetchedUrl).not.toContain("max=");
    expect(fetchedUrl).toContain("/api/games/user/Foe");
  });

  it("maps fetch errors to user-facing messages", () => {
    expect(scoutFetchErrorMessage(new TypeError("fetch failed"))).toBe(SCOUT_ERR_NETWORK);
    expect(scoutFetchErrorMessage(new Error(SCOUT_ERR_RATE_LIMIT))).toBe(SCOUT_ERR_RATE_LIMIT);
    expect(scoutFetchErrorMessage(new Error("other"))).toBeNull();
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

  it("builds an export URL without max by default", () => {
    const url = scoutUrl("Foe");
    expect(url).toContain("/api/games/user/Foe?");
    expect(url).not.toContain("max=");
    expect(url).toContain("perfType=bullet%2Cblitz%2Crapid%2Cclassical");
  });

  it("drops bullet from perfType when excludeBullet is set", () => {
    const url = scoutUrl("Foe", null, { excludeBullet: true });
    expect(url).toContain("perfType=blitz%2Crapid%2Cclassical");
    expect(url).not.toContain("bullet");
  });

  it("passes an explicit max through without capping", () => {
    const url = scoutUrl("Foe", 9999);
    expect(url).toContain("max=9999");
  });

  it("builds a streaming URL with colour and pagination params", () => {
    const url = scoutStreamUrl("Foe", { color: "white", until: 1_700_000_000, max: 120 });
    expect(url).toContain("color=white");
    expect(url).toContain("until=1700000000");
    expect(url).toContain("max=120");
    const defaultUrl = scoutStreamUrl("Foe", { color: "both" });
    expect(defaultUrl).not.toContain("color=");
    expect(defaultUrl).not.toContain("max=");
  });

  it("excludes bullet from the streaming export", () => {
    const url = scoutStreamUrl("Foe", { color: "both" });
    expect(url).toContain("perfType=blitz%2Crapid%2Cclassical");
    expect(url).not.toContain("bullet");
  });

  it("streams PGN chunks split mid-game and emits complete games", async () => {
    const g1 = pgn({ moves: "1. e4 e5", utcDate: "2026.06.12", white: "Foe" });
    const g2 = pgn({ moves: "1. d4 d5", utcDate: "2026.06.11", white: "Foe" });
    const full = `${g1}\n\n${g2}`;
    const encoder = new TextEncoder();
    let readCount = 0;
    const stream = new ReadableStream({
      pull(controller) {
        readCount += 1;
        if (readCount === 1) {
          controller.enqueue(encoder.encode(full.slice(0, 40)));
        } else if (readCount === 2) {
          controller.enqueue(encoder.encode(full.slice(40)));
          controller.close();
        }
      },
    });
    const games = [];
    const client = createScoutClient({
      fetchImpl: async () => ({ ok: true, status: 200, body: stream }),
      storage: memoryStorage(),
    });
    const result = await client.streamGames("Foe", {
      onGame: (g) => games.push(g),
    });
    expect(games).toHaveLength(2);
    expect(result.accepted).toBe(2);
    expect(result.emitted).toBe(2);
    expect(result.lastDatestamp).toBe(
      Math.min(games[0].datestamp, games[1].datestamp),
    );
  });

  it("treats AbortError as a normal stop and keeps partial emits", async () => {
    const g1 = pgn({ moves: "1. e4 e5", white: "Foe" });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(g1));
      },
    });
    const ctrl = new AbortController();
    const games = [];
    const client = createScoutClient({
      fetchImpl: async () => ({ ok: true, status: 200, body: stream }),
      storage: memoryStorage(),
    });
    ctrl.abort();
    const result = await client.streamGames("Foe", {
      onGame: (g) => games.push(g),
      signal: ctrl.signal,
    });
    expect(result.accepted).toBe(0);
    expect(games).toHaveLength(0);
  });

  it("counts only accepted games when onGame rejects resume duplicates", async () => {
    const g1 = pgn({
      moves: "1. e4 e5",
      white: "Foe",
      utcDate: "2026.06.10",
      site: "https://lichess.org/abc123",
    });
    const g2 = pgn({
      moves: "1. d4 d5",
      white: "Foe",
      utcDate: "2026.06.09",
      site: "https://lichess.org/def456",
    });
    const full = `${g1}\n\n${g2}\n\n${g1}`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(full));
        controller.close();
      },
    });
    const seen = new Set();
    const acceptedGames = [];
    const client = createScoutClient({
      fetchImpl: async () => ({ ok: true, status: 200, body: stream }),
      storage: memoryStorage(),
    });
    const result = await client.streamGames("Foe", {
      onGame: (g) => {
        if (g.gameId && seen.has(g.gameId)) return false;
        if (g.gameId) seen.add(g.gameId);
        acceptedGames.push(g);
        return true;
      },
    });
    expect(acceptedGames).toHaveLength(2);
    expect(result.accepted).toBe(2);
    expect(PGN_BLOCK_BOUNDARY.test(`\n\n[Event "x"]`)).toBe(true);
  });

  it("returns accepted=0 for a resume page of only duplicate gameIds", async () => {
    const g1 = pgn({
      moves: "1. e4 e5",
      white: "Foe",
      site: "https://lichess.org/duponly",
    });
    const full = `${g1}\n\n${g1}`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(full));
        controller.close();
      },
    });
    const seen = new Set(["duponly"]);
    const client = createScoutClient({
      fetchImpl: async () => ({ ok: true, status: 200, body: stream }),
      storage: memoryStorage(),
    });
    const result = await client.streamGames("Foe", {
      onGame: (g) => {
        if (g.gameId && seen.has(g.gameId)) return false;
        if (g.gameId) seen.add(g.gameId);
        return true;
      },
    });
    expect(result.accepted).toBe(0);
  });

  it("parses deeper movetext for analysis", () => {
    const sans = movetextSans(Array(30).fill("e4").join(" "), ANALYZE_PLIES);
    expect(sans.length).toBe(ANALYZE_PLIES);
    expect(ANALYZE_PLIES).toBeGreaterThan(MAX_PLIES);
  });
});
