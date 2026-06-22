import { describe, expect, it, vi } from "vitest";

import {
  ANALYZE_PLIES,
  MAX_PLIES,
  buildOpeningTrie,
  createScoutClient,
  SCOUT_ERR_NETWORK,
  SCOUT_ERR_RATE_LIMIT,
  scoutFetchErrorMessage,
  fenAfterLine,
  gradeLines,
  lineCoverage,
  moveDistribution,
  movetextSans,
  openingBreakdown,
  opponentProfile,
  parseGameBlock,
  parseMultiPgn,
  nodeIdAfterFlush,
  clearOpeningPhaseCache,
  rankGamePlan,
  dedupNestedLines,
  compareMaiaGamePlanRank,
  compareMaiaCandidatePriority,
  selectMaiaEnrichCandidates,
  gamePlanPathKey,
  gamePlanSourcePathKey,
  applyTrieNodeStats,
  lineStatsFromTrieNode,
  trieNodeAtPath,
  rankedOpeningLines,
  recommendTargets,
  normalizeToOpponentTerminal,
  terminalMoveIsOpponent,
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
import { lineLastSeen } from "./scout-stats.js";

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

describe("rankedOpeningLines + rankGamePlan", () => {
  it("collects opening-boundary lines from the trie", () => {
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    const lines = rankedOpeningLines(trie, { minGames: 1 });
    expect(lines.some((g) => g.sans[0] === "e4")).toBe(true);
    expect(lines.some((g) => g.sans[0] === "d4")).toBe(true);
    for (const line of lines) {
      expect(line.sans.length).toBeGreaterThan(0);
      expect(line.sans.length).toBeLessThanOrEqual(MAX_PLIES);
    }
  });

  it("reports a real-count rawShare even when recency decays count to ~0", () => {
    // One d4 game from long ago: its recency-weighted count/share collapse toward 0,
    // but the line is still a real n=1 prep target — rawShare/games must reflect that.
    const old = Date.now() - 400 * 86_400_000;
    const games = [
      ...Array.from({ length: 20 }, (_, i) => ({
        color: "white",
        score: 1,
        sans: ["e4", "c5"],
        ucis: ["e2e4", "c7c5"],
        rating: 1800,
        datestamp: Date.now() - i * 86_400_000,
        speed: "blitz",
      })),
      {
        color: "white",
        score: 0,
        sans: ["d4", "d5"],
        ucis: ["d2d4", "d7d5"],
        rating: 1800,
        datestamp: old,
        speed: "blitz",
      },
    ];
    const trie = buildOpeningTrie(games, "white", { recency: true });
    const lines = rankedOpeningLines(trie, { minGames: 1 });
    const d4 = lines.find((l) => l.ucis[0] === "d2d4");
    expect(d4).toBeDefined();
    expect(d4.games).toBe(1); // real game count, undecayed
    expect(Math.round(d4.count)).toBe(0); // recency weight rounds to 0 (the old bug source)
    expect(d4.rawShare).toBeCloseTo(1 / 21, 4); // raw proportion is non-zero
  });

  it("With White keeps distinct d4 lines ending on White's move", () => {
    const londonGames = [
      ...Array.from({ length: 10 }, (_, i) => ({
        color: "white",
        score: 0.5,
        sans: ["d4", "Nf6", "c4"],
        ucis: ["d2d4", "g8f6", "c2c4"],
        rating: 1800,
        datestamp: 3000 - i,
        speed: "blitz",
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        color: "white",
        score: 0,
        sans: ["d4", "d5", "c4"],
        ucis: ["d2d4", "d7d5", "c2c4"],
        rating: 1800,
        datestamp: 2000 - i,
        speed: "blitz",
      })),
    ];
    const trie = buildOpeningTrie(londonGames, "white", { recency: false });
    const lines = rankedOpeningLines(trie, { oppColor: "white" });
    const nf6 = lines.find((l) => l.ucis.join(">") === "d2d4>g8f6>c2c4");
    const d5 = lines.find((l) => l.ucis.join(">") === "d2d4>d7d5>c2c4");
    expect(nf6).toBeDefined();
    expect(d5).toBeDefined();
    expect(terminalMoveIsOpponent(nf6.ucis, "white")).toBe(true);
    expect(terminalMoveIsOpponent(d5.ucis, "white")).toBe(true);
    const collapsed = lines.find((l) => l.ucis.length === 1 && l.ucis[0] === "d2d4");
    expect(collapsed).toBeUndefined();
  });

  it("With Black ends lines on Black's move with White context bridged", () => {
    const games = [
      ...Array.from({ length: 6 }, () => ({
        color: "black",
        score: 1,
        sans: ["e4", "c5", "Nf3"],
        ucis: ["e2e4", "c7c5", "g1f3"],
        rating: 1750,
        datestamp: 1000,
        speed: "blitz",
      })),
      ...Array.from({ length: 4 }, () => ({
        color: "black",
        score: 0,
        sans: ["e4", "e5", "Nf3"],
        ucis: ["e2e4", "e7e5", "g1f3"],
        rating: 1750,
        datestamp: 2000,
        speed: "blitz",
      })),
    ];
    const trie = buildOpeningTrie(games, "black", { recency: false });
    const lines = rankedOpeningLines(trie, { oppColor: "black" });
    const sicilian = lines.find((l) => l.ucis.join(">") === "e2e4>c7c5");
    expect(sicilian).toBeDefined();
    expect(terminalMoveIsOpponent(sicilian.ucis, "black")).toBe(true);
    expect(sicilian.sans).toEqual(["e4", "c5"]);
  });

  it("reuses opening-phase cache across shared path prefixes", () => {
    clearOpeningPhaseCache();
    const trie = buildOpeningTrie(GAMES, "white", { recency: false });
    const cache = new Map();
    rankedOpeningLines(trie, { minGames: 1, phaseCache: cache });
    const sizeAfterFirst = cache.size;
    rankedOpeningLines(trie, { minGames: 1, phaseCache: cache });
    expect(sizeAfterFirst).toBeGreaterThan(0);
    expect(cache.size).toBe(sizeAfterFirst);
  });

  it("dedupes nested prefixes before Maia ranking", () => {
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
      maiaScorePct: 18,
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
      maiaScorePct: 72,
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
      maiaScorePct: 40,
    };
    const ranked = rankGamePlan([strong, nested, weak], 50, { minGames: 7, oppColor: "white" });
    expect(ranked.assessed).toHaveLength(2);
    expect(ranked.assessed[0].ucis).toEqual(["e2e4", "c7c5", "g1f3"]);
    expect(ranked.assessed[0].maiaScorePct).toBeLessThan(ranked.assessed[1].maiaScorePct);
    expect(terminalMoveIsOpponent(ranked.assessed[0].ucis, "white")).toBe(true);
    expect(dedupNestedLines([nested, weak], { oppColor: "white" })).toHaveLength(1);
  });

  it("dedup keeps sibling branches and is independent of input order", () => {
    const nf6 = {
      line: "d2d4>g8f6>c2c4",
      ucis: ["d2d4", "g8f6", "c2c4"],
      sans: ["d4", "Nf6", "c4"],
      games: 10,
    };
    const d5 = {
      line: "d2d4>d7d5>c2c4",
      ucis: ["d2d4", "d7d5", "c2c4"],
      sans: ["d4", "d5", "c4"],
      games: 8,
    };
    const parent = {
      line: "d2d4",
      ucis: ["d2d4"],
      sans: ["d4"],
      games: 18,
    };
    const forward = dedupNestedLines([parent, nf6, d5], { oppColor: "white" });
    const reverse = dedupNestedLines([d5, nf6, parent], { oppColor: "white" });
    expect(forward.map(gamePlanPathKey).sort()).toEqual(
      reverse.map(gamePlanPathKey).sort(),
    );
    expect(forward.map(gamePlanPathKey).sort()).toEqual(
      ["d2d4>d7d5>c2c4", "d2d4>g8f6>c2c4"].sort(),
    );
    expect(forward.some((l) => gamePlanPathKey(l) === "d2d4")).toBe(false);
  });

  it("lineStatsFromTrieNode uses root weighted totals for share", () => {
    const games = [
      { color: "white", score: 1, sans: ["d4"], ucis: ["d2d4"], datestamp: 1, speed: "blitz" },
      { color: "white", score: 0, sans: ["e4"], ucis: ["e2e4"], datestamp: 2, speed: "blitz" },
    ];
    const trie = buildOpeningTrie(games, "white", { recency: false });
    const d4Hit = trieNodeAtPath(trie, ["d2d4"], ["d4"]);
    const stats = lineStatsFromTrieNode(trie, d4Hit.node, d4Hit.sans, d4Hit.ucis, "d2d4");
    expect(stats.games).toBe(1);
    expect(stats.share).toBeCloseTo(0.5, 4);
    expect(stats.rawShare).toBeCloseTo(0.5, 4);
  });

  it("same terminal path uses trie aggregates instead of truncated child stats", () => {
    const games = [
      ...Array.from({ length: 10 }, (_, i) => ({
        color: "white",
        score: 1,
        sans: ["d4"],
        ucis: ["d2d4"],
        rating: 1800,
        datestamp: i,
        speed: "blitz",
      })),
      {
        color: "white",
        score: 0,
        sans: ["d4", "Nf6"],
        ucis: ["d2d4", "g8f6"],
        rating: 1800,
        datestamp: 100,
        speed: "blitz",
      },
    ];
    const trie = buildOpeningTrie(games, "white", { recency: false });
    const shallow = {
      line: "d2d4",
      ucis: ["d2d4"],
      sans: ["d4"],
      games: 10,
      share: 1,
      count: 10,
    };
    const deep = {
      line: "d2d4>g8f6",
      ucis: ["d2d4", "g8f6"],
      sans: ["d4", "Nf6"],
      games: 1,
      share: 0.09,
      count: 1,
    };
    const deduped = dedupNestedLines([deep, shallow], { oppColor: "white", trie, games });
    expect(deduped).toHaveLength(1);
    expect(deduped[0].games).toBe(11);
    expect(deduped[0].share).toBeCloseTo(1, 4);
    expect(deduped[0].ucis).toEqual(["d2d4"]);
    expect(
      applyTrieNodeStats(
        { ...deep, ucis: ["d2d4"], sans: ["d4"], line: "d2d4" },
        trie,
      ).games,
    ).toBe(11);
    expect(gamePlanSourcePathKey(deduped[0])).toBe("d2d4>g8f6");
  });

  it("terminal merge recomputes lastSeen on normalized path not child metadata", () => {
    const games = [
      ...Array.from({ length: 5 }, (_, i) => ({
        color: "white",
        score: 1,
        sans: ["d4"],
        ucis: ["d2d4"],
        datestamp: 8000 + i,
        speed: "blitz",
      })),
      {
        color: "white",
        score: 0,
        sans: ["d4", "Nf6"],
        ucis: ["d2d4", "g8f6"],
        datestamp: 1000,
        speed: "blitz",
      },
    ];
    const trie = buildOpeningTrie(games, "white", { recency: false });
    const deep = {
      line: "d2d4>g8f6",
      ucis: ["d2d4", "g8f6"],
      sans: ["d4", "Nf6"],
      games: 1,
      lastSeen: { lastDatestamp: 1000, daysAgo: 999 },
    };
    const deduped = dedupNestedLines([deep], {
      oppColor: "white",
      trie,
      games,
      lineLastSeen,
    });
    expect(deduped[0].lastSeen?.lastDatestamp).toBe(8004);
  });

  it("selectMaiaEnrichCandidates prefers recent lines when over cap", () => {
    const lines = [
      {
        line: "e2e4",
        ucis: ["e2e4"],
        sans: ["e4"],
        share: 0.5,
        games: 10,
        lastSeen: { lastDatestamp: 1000 },
      },
      {
        line: "d2d4",
        ucis: ["d2d4"],
        sans: ["d4"],
        share: 0.1,
        games: 2,
        lastSeen: { lastDatestamp: 9000 },
      },
    ];
    const picked = selectMaiaEnrichCandidates(lines, { oppColor: "white", limit: 1 });
    expect(picked).toHaveLength(1);
    expect(gamePlanPathKey(picked[0])).toBe("d2d4");
    expect(compareMaiaCandidatePriority(lines[1], lines[0])).toBeLessThan(0);
  });

  it("keeps unassessed lines out of the Maia-ranked list", () => {
    const attackNoMaia = {
      line: "e2e4>c7c5>g1f3",
      sans: ["e4", "c5", "Nf3"],
      ucis: ["e2e4", "c7c5", "g1f3"],
      games: 1, w: 0, d: 0, l: 1, scorePct: 0, share: 0.1, count: 1,
    };
    const weaponWithMaia = {
      line: "d2d4",
      sans: ["d4"],
      ucis: ["d2d4"],
      games: 1, w: 1, d: 0, l: 0, scorePct: 100, share: 0.1, count: 1,
      maiaScorePct: 74, maiaWdl: { win: 74, draw: 13, loss: 13 },
    };
    const ranked = rankGamePlan([weaponWithMaia, attackNoMaia], 50, { oppColor: "white" });
    expect(ranked.assessed).toHaveLength(1);
    expect(ranked.assessed[0].ucis).toEqual(["d2d4"]);
    expect(ranked.unassessed).toHaveLength(1);
    expect(ranked.unassessed[0].ucis).toEqual(["e2e4", "c7c5", "g1f3"]);
  });

  it("tie-breaks equal Maia scores by recency then route key", () => {
    const older = {
      line: "d2d4",
      ucis: ["d2d4"],
      games: 5,
      maiaScorePct: 40,
      lastSeen: { lastDatestamp: 1000 },
    };
    const newer = {
      line: "e2e4",
      ucis: ["e2e4"],
      games: 5,
      maiaScorePct: 40,
      lastSeen: { lastDatestamp: 2000 },
    };
    expect(compareMaiaGamePlanRank(newer, older)).toBeLessThan(0);
    expect(compareMaiaGamePlanRank(older, newer)).toBeGreaterThan(0);
  });

  it("returns all qualifying assessed lines without an artificial cap", () => {
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
        maiaScorePct: 25,
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
        maiaScorePct: 11,
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
        maiaScorePct: 43,
      },
    ];
    const ranked = rankGamePlan(lines, 55, { minGames: 7, oppColor: "white", limit: 0 });
    expect(ranked.assessed.length).toBeGreaterThanOrEqual(3);
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