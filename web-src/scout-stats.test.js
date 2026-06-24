import { describe, expect, it } from "vitest";

import {
  aggregateOpeningBranches,
  SCOUT_RECENCY_HALF_LIFE_DAYS,
} from "./scout.js";
import {
  ACTIVITY_RECENT_BUCKETS,
  activitySeries,
  BREADTH_MIN_GAMES,
  buildScoutStats,
  COLOR_COMPARE_MIN_GAMES,
  colorRecommendation,
  confidence,
  FRESHNESS_MIN_RECENT,
  formTrend,
  personaTags,
  petLineConcentration,
  predictability,
  ratingTrajectory,
  repertoireBreadth,
  repertoireFreshness,
  scoreByFamily,
  scoreBySpeed,
  scoreVsStronger,
  SPEED_BUCKET_MIN_GAMES,
  STRONGER_DEFAULT_THRESHOLD,
  SYSTEM_TAG_MIN_GAMES,
  SYSTEM_TAG_MIN_SHARE,
} from "./scout-stats.js";

function game({
  color = "white",
  score = 1,
  san = "e4",
  uci = "e2e4",
  sans,
  ucis,
  rating = 1800,
  opponentRating = 1800,
  datestamp = 1000,
  speed = "blitz",
  gameId = "g1",
}) {
  return {
    color,
    score,
    sans: sans || [san],
    ucis: ucis || [uci],
    rating,
    opponentRating,
    datestamp,
    speed,
    gameId,
  };
}

describe("confidence", () => {
  it("returns none for empty sample", () => {
    expect(confidence(0).level).toBe("none");
    expect(confidence(-1).level).toBe("none");
  });

  it("returns low for small sample", () => {
    expect(confidence(1).level).toBe("low");
    expect(confidence(4).level).toBe("low");
  });

  it("returns medium and high at thresholds", () => {
    expect(confidence(5).level).toBe("medium");
    expect(confidence(14).level).toBe("medium");
    expect(confidence(15).level).toBe("high");
  });
});

describe("scoreByFamily", () => {
  it("returns empty families for empty sample", () => {
    const out = scoreByFamily([], "white");
    expect(out.families).toEqual([]);
    expect(out.baseline).toBe(0);
    expect(out.confidence.level).toBe("none");
  });

  it("hides first-move families below slip threshold", () => {
    const games = [game({ score: 0, gameId: "a" }), game({ score: 1, gameId: "b" })];
    const out = scoreByFamily(games, "white");
    expect(out.families).toHaveLength(0);
    const sampled = Array.from({ length: 3 }, (_, i) => game({ score: i % 2, gameId: `g${i}` }));
    const withSample = scoreByFamily(sampled, "white");
    expect(withSample.families).toHaveLength(1);
    expect(withSample.families[0].wilsonScorePct).toBeDefined();
  });

  it("ranks families worst-first by Wilson bound and respects date ordering in recentTrend", () => {
    const games = [
      game({ san: "e4", ucis: ["e2e4"], score: 1, datestamp: 3000, gameId: "e3" }),
      game({ san: "e4", ucis: ["e2e4"], score: 0, datestamp: 2000, gameId: "e2" }),
      game({ san: "e4", ucis: ["e2e4"], score: 1, datestamp: 2500, gameId: "e4" }),
      game({ san: "d4", ucis: ["d2d4"], score: 0, datestamp: 1000, gameId: "d1" }),
      game({ san: "d4", ucis: ["d2d4"], score: 0, datestamp: 4000, gameId: "d2" }),
      game({ san: "d4", ucis: ["d2d4"], score: 0, datestamp: 3500, gameId: "d3" }),
    ];
    const out = scoreByFamily(games, "white");
    expect(out.families[0].san).toBe("d4");
    expect(out.families[0].scorePct).toBe(0);
    expect(out.families[1].san).toBe("e4");
    expect(out.families[1].scorePct).toBe(67);
    expect(out.families[1].recentTrend[0]).toBe(0);
    expect(out.families[1].recentTrend[1]).toBe(50);
  });

  it("filters by White/Black", () => {
    const games = [
      ...Array.from({ length: 3 }, () => game({ color: "white", san: "e4", ucis: ["e2e4"], score: 1 })),
      ...Array.from({ length: 3 }, () => game({ color: "black", san: "e4", ucis: ["e2e4"], score: 0 })),
    ];
    const white = scoreByFamily(games, "white");
    const black = scoreByFamily(games, "black");
    expect(white.games).toBe(3);
    expect(black.games).toBe(3);
    expect(white.families[0].scorePct).toBe(100);
    expect(black.families[0].scorePct).toBe(0);
  });
});

describe("formTrend", () => {
  it("returns empty points for empty sample", () => {
    const out = formTrend([], 5);
    expect(out.points).toEqual([]);
    expect(out.confidence.level).toBe("none");
  });

  it("handles small sample", () => {
    const out = formTrend([game({ score: 1 }), game({ score: 0 })], 2);
    expect(out.points).toHaveLength(2);
    expect(out.points[1]).toBe(50);
    expect(out.confidence.level).toBe("low");
  });

  it("orders chronologically (oldest left, newest right)", () => {
    const games = [
      game({ score: 0, datestamp: 3000, gameId: "n" }),
      game({ score: 1, datestamp: 1000, gameId: "o" }),
      game({ score: 1, datestamp: 2000, gameId: "m" }),
    ];
    const out = formTrend(games, 1);
    expect(out.points[0]).toBe(100);
    expect(out.points[1]).toBe(100);
    expect(out.points[2]).toBe(0);
  });

  it("filters by White/Black", () => {
    const games = [
      game({ color: "white", score: 1 }),
      game({ color: "black", score: 0 }),
      game({ color: "white", score: 0 }),
    ];
    const white = formTrend(games, 2, { color: "white" });
    expect(white.games).toBe(2);
    expect(white.points[1]).toBe(50);
  });
});

describe("ratingTrajectory", () => {
  it("returns empty points for empty sample", () => {
    const out = ratingTrajectory([]);
    expect(out.points).toEqual([]);
    expect(out.confidence.level).toBe("none");
  });

  it("handles small sample", () => {
    const out = ratingTrajectory([game({ rating: 1500 }), game({ rating: 1600 })]);
    expect(out.points).toHaveLength(2);
    expect(out.confidence.level).toBe("low");
  });

  it("orders chronologically", () => {
    const games = [
      game({ rating: 1700, datestamp: 3000, gameId: "c" }),
      game({ rating: 1500, datestamp: 1000, gameId: "a" }),
      game({ rating: 1600, datestamp: 2000, gameId: "b" }),
    ];
    const out = ratingTrajectory(games);
    expect(out.points.map((p) => p.rating)).toEqual([1500, 1600, 1700]);
    expect(out.trend).toBe("up");
  });

  it("filters by White/Black", () => {
    const games = [
      game({ color: "white", rating: 1800 }),
      game({ color: "black", rating: 1200 }),
    ];
    const white = ratingTrajectory(games, { color: "white" });
    expect(white.games).toBe(1);
    expect(white.points[0].rating).toBe(1800);
  });
});

describe("activitySeries", () => {
  it("returns empty buckets for empty sample", () => {
    const out = activitySeries([]);
    expect(out.buckets).toEqual([]);
    expect(out.confidence.level).toBe("none");
  });

  it("handles small sample", () => {
    const out = activitySeries([game({ datestamp: Date.parse("2024-01-01") })]);
    expect(out.buckets).toHaveLength(1);
    expect(out.buckets[0].count).toBe(1);
    expect(out.confidence.level).toBe("low");
  });

  it("orders buckets chronologically", () => {
    const d1 = Date.parse("2024-01-01");
    const d2 = Date.parse("2024-01-15");
    const d3 = Date.parse("2024-02-01");
    const games = [
      game({ datestamp: d3, gameId: "c" }),
      game({ datestamp: d1, gameId: "a" }),
      game({ datestamp: d2, gameId: "b" }),
    ];
    const out = activitySeries(games, { bucketDays: 7 });
    expect(out.buckets[0].datestamp).toBeLessThan(out.buckets[out.buckets.length - 1].datestamp);
    expect(out.games).toBe(3);
  });

  it("filters by White/Black", () => {
    const day = Date.parse("2024-03-01");
    const games = [
      game({ color: "white", datestamp: day }),
      game({ color: "black", datestamp: day }),
      game({ color: "white", datestamp: day, gameId: "w2" }),
    ];
    const white = activitySeries(games, { color: "white" });
    expect(white.games).toBe(2);
    expect(white.buckets.reduce((n, b) => n + b.count, 0)).toBe(2);
  });

  it("zero-fills recent calendar buckets anchored on the newest game", () => {
    const y2022 = Date.parse("2022-06-01");
    const y2024 = Date.parse("2024-06-01");
    const y2026 = Date.parse("2026-06-01");
    const games = [
      game({ datestamp: y2022, gameId: "old" }),
      game({ datestamp: y2024, gameId: "mid" }),
      game({ datestamp: y2026, gameId: "new" }),
    ];
    const out = activitySeries(games, { recentBuckets: ACTIVITY_RECENT_BUCKETS });
    expect(out.buckets).toHaveLength(3);
    expect(out.recentWindow).toHaveLength(ACTIVITY_RECENT_BUCKETS);
    expect(out.recentGames).toBe(1);
    expect(out.recentWindow.every((b) => b.count === 0 || b.datestamp >= out.recentWindow[0].datestamp)).toBe(
      true,
    );
    const totalRecent = out.recentWindow.reduce((n, b) => n + b.count, 0);
    expect(totalRecent).toBe(1);
  });
});

describe("colorRecommendation", () => {
  it("returns null for empty sample", () => {
    expect(colorRecommendation([])).toBeNull();
  });

  it("picks opposite color when one side is clearly weaker", () => {
    const games = [
      ...Array.from({ length: 5 }, (_, i) =>
        game({ color: "white", score: 0, gameId: `w${i}` }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        game({ color: "black", score: 1, gameId: `b${i}` }),
      ),
    ];
    const rec = colorRecommendation(games);
    expect(rec.pick).toBe("black");
    expect(rec.theirWeakColor).toBe("white");
    expect(rec.confidence.n).toBe(5);
  });

  it("returns insufficient comparison when one color lacks minimum sample", () => {
    const games = [
      ...Array.from({ length: 15 }, (_, i) =>
        game({ color: "white", score: 0, gameId: `w${i}` }),
      ),
      game({ color: "black", score: 1, gameId: "b0" }),
    ];
    const rec = colorRecommendation(games);
    expect(rec.insufficient).toBe(true);
    expect(rec.pick).toBeNull();
    expect(rec.whiteGames).toBe(15);
    expect(rec.blackGames).toBe(1);
    expect(rec.confidence.n).toBe(1);
    expect(rec.confidence.level).toBe("low");
  });

  it(`requires at least ${COLOR_COMPARE_MIN_GAMES} games on both colors`, () => {
    const games = [
      game({ color: "white", gameId: "w1" }),
      game({ color: "white", gameId: "w2" }),
      game({ color: "black", gameId: "b1" }),
    ];
    expect(colorRecommendation(games).insufficient).toBe(true);
  });
});

describe("predictability", () => {
  it("returns empty metrics for empty sample", () => {
    const out = predictability([], "white");
    expect(out.games).toBe(0);
    expect(out.moves).toEqual([]);
    expect(out.confidence.level).toBe("none");
  });

  it("labels a single first move as predictable on small sample", () => {
    const games = [game({ gameId: "a" }), game({ gameId: "b" })];
    const out = predictability(games, "white");
    expect(out.label).toBe("predictable");
    expect(out.topMove.share).toBe(1);
    expect(out.confidence.level).toBe("low");
  });

  it("rises with varied first moves", () => {
    const games = [
      game({ san: "e4", uci: "e2e4", gameId: "e" }),
      game({ san: "d4", uci: "d2d4", gameId: "d" }),
      game({ san: "c4", uci: "c2c4", gameId: "c" }),
      game({ san: "Nf3", uci: "g1f3", gameId: "n" }),
    ];
    const out = predictability(games, "white");
    expect(out.normalized).toBeGreaterThan(0.7);
    expect(out.label).toBe("unpredictable");
  });

  it("filters by White/Black", () => {
    const games = [
      game({ color: "white", san: "e4", uci: "e2e4" }),
      game({ color: "black", san: "e4", uci: "e2e4" }),
      game({ color: "black", san: "d4", uci: "d2d4", gameId: "b2" }),
    ];
    expect(predictability(games, "white").moves).toHaveLength(1);
    expect(predictability(games, "black").moves).toHaveLength(2);
  });

  it("ignores a one-off mouse-slip first move when labelling predictability", () => {
    const games = [];
    for (let i = 0; i < 12; i += 1) {
      games.push(game({ san: "d4", uci: "d2d4", gameId: `d${i}` }));
    }
    // A single 1.d3 slip (n=1) must not push a dominant-d4 player off "predictable".
    games.push(game({ san: "d3", uci: "d2d3", gameId: "slip" }));
    const out = predictability(games, "white");
    expect(out.label).toBe("predictable");
    expect(out.topMove.san).toBe("d4");
  });

  it("calls a dominant top move predictable even with a thin second weapon", () => {
    const games = [];
    for (let i = 0; i < 17; i += 1) games.push(game({ san: "d4", uci: "d2d4", gameId: `d${i}` }));
    for (let i = 0; i < 4; i += 1) games.push(game({ san: "Nf3", uci: "g1f3", gameId: `n${i}` }));
    const out = predictability(games, "white");
    expect(out.topMove.share).toBeGreaterThan(0.7);
    expect(out.label).toBe("predictable");
  });
});

describe("petLineConcentration", () => {
  it("returns empty metrics for empty sample", () => {
    const out = petLineConcentration([], "white");
    expect(out.games).toBe(0);
    expect(out.top3Share).toBe(0);
    expect(out.confidence.level).toBe("none");
  });

  it("marks a repeated pet line as concentrated on small sample", () => {
    const line = {
      sans: ["e4", "c5", "Nf3"],
      ucis: ["e2e4", "c7c5", "g1f3"],
    };
    const games = [
      game({ ...line, gameId: "a" }),
      game({ ...line, gameId: "b" }),
      game({ sans: ["d4"], ucis: ["d2d4"], gameId: "c" }),
    ];
    const out = petLineConcentration(games, "white");
    expect(out.top3SharePct).toBe(100);
    expect(out.label).toBe("concentrated");
    expect(out.confidence.level).toBe("low");
  });

  it("drops when many distinct paths share the sample", () => {
    const games = [
      game({ sans: ["e4"], ucis: ["e2e4"], gameId: "1" }),
      game({ sans: ["d4"], ucis: ["d2d4"], gameId: "2" }),
      game({ sans: ["c4"], ucis: ["c2c4"], gameId: "3" }),
      game({ sans: ["Nf3"], ucis: ["g1f3"], gameId: "4" }),
      game({ sans: ["b3"], ucis: ["b2b3"], gameId: "5" }),
    ];
    const out = petLineConcentration(games, "white");
    expect(out.top3SharePct).toBe(60);
    expect(out.label).toBe("moderate");
  });

  it("filters by White/Black", () => {
    const line = { sans: ["e4", "c5"], ucis: ["e2e4", "c7c5"] };
    const games = [
      game({ color: "white", ...line }),
      game({ color: "black", sans: ["d4"], ucis: ["d2d4"], gameId: "b" }),
    ];
    expect(petLineConcentration(games, "white").games).toBe(1);
    expect(petLineConcentration(games, "black").games).toBe(1);
  });
});

describe("repertoireBreadth", () => {
  it("returns zero breadth for empty sample", () => {
    const out = repertoireBreadth([], "white");
    expect(out.breadth).toBe(0);
    expect(out.confidence.level).toBe("none");
  });

  it("ignores first moves below minGames on small sample", () => {
    const games = [
      game({ san: "e4", uci: "e2e4", gameId: "a" }),
      game({ san: "e4", uci: "e2e4", gameId: "b" }),
      game({ san: "d4", uci: "d2d4", gameId: "c" }),
    ];
    const out = repertoireBreadth(games, "white", { minGames: BREADTH_MIN_GAMES });
    expect(out.breadth).toBe(0);
    expect(out.confidence.level).toBe("low");
  });

  it("counts first moves that clear minGames", () => {
    const games = [
      ...Array.from({ length: 3 }, (_, i) => game({ san: "e4", uci: "e2e4", gameId: `e${i}` })),
      ...Array.from({ length: 3 }, (_, i) => game({ san: "d4", uci: "d2d4", gameId: `d${i}` })),
      game({ san: "c4", uci: "c2c4", gameId: "c1" }),
    ];
    const out = repertoireBreadth(games, "white");
    expect(out.breadth).toBe(2);
    expect(out.moves.map((m) => m.san).sort()).toEqual(["d4", "e4"]);
  });

  it("filters by White/Black", () => {
    const games = [
      ...Array.from({ length: 3 }, (_, i) => game({ color: "white", san: "e4", uci: "e2e4", gameId: `w${i}` })),
      ...Array.from({ length: 3 }, (_, i) => game({ color: "black", san: "e4", uci: "e2e4", gameId: `b${i}` })),
    ];
    expect(repertoireBreadth(games, "white").breadth).toBe(1);
    expect(repertoireBreadth(games, "black").breadth).toBe(1);
  });
});

describe("repertoireFreshness", () => {
  it("returns no fresh families for empty sample", () => {
    const out = repertoireFreshness([], "white");
    expect(out.freshFamilies).toEqual([]);
    expect(out.confidence.level).toBe("none");
  });

  it("flags families that appear only in the recent window", () => {
    const games = [
      game({ san: "d4", uci: "d2d4", datestamp: 3000, gameId: "r1" }),
      game({ san: "d4", uci: "d2d4", datestamp: 2900, gameId: "r2" }),
      game({ san: "e4", uci: "e2e4", datestamp: 1000, gameId: "p1" }),
      game({ san: "e4", uci: "e2e4", datestamp: 900, gameId: "p2" }),
    ];
    const out = repertoireFreshness(games, "white", { minRecent: FRESHNESS_MIN_RECENT, recentWindow: 2, previousWindow: 2 });
    expect(out.freshFamilies).toHaveLength(1);
    expect(out.freshFamilies[0].san).toBe("d4");
    expect(out.freshFamilies[0].previousGames).toBe(0);
    expect(out.confidence.level).toBe("low");
  });

  it("respects newest-first ordering for recent vs previous windows", () => {
    const games = [
      game({ san: "c4", uci: "c2c4", datestamp: 5000, gameId: "new" }),
      game({ san: "e4", uci: "e2e4", datestamp: 4000, gameId: "old-recent" }),
      game({ san: "e4", uci: "e2e4", datestamp: 3000, gameId: "old-prev" }),
    ];
    const out = repertoireFreshness(games, "white", { minRecent: 1, recentWindow: 2, previousWindow: 1 });
    expect(out.freshFamilies.some((f) => f.san === "c4")).toBe(true);
    expect(out.freshFamilies.some((f) => f.san === "e4")).toBe(false);
  });

  it("filters by White/Black", () => {
    const games = [
      game({ color: "white", san: "d4", uci: "d2d4", datestamp: 2000, gameId: "w1" }),
      game({ color: "white", san: "d4", uci: "d2d4", datestamp: 1900, gameId: "w2" }),
      game({ color: "black", san: "e4", uci: "e2e4", datestamp: 1000, gameId: "b1" }),
    ];
    const white = repertoireFreshness(games, "white", { minRecent: 2, recentWindow: 2, previousWindow: 2 });
    const black = repertoireFreshness(games, "black", { minRecent: 1, recentWindow: 1, previousWindow: 1 });
    expect(white.freshFamilies).toHaveLength(1);
    expect(black.freshFamilies).toHaveLength(1);
    expect(black.freshFamilies[0].san).toBe("e4");
  });
});

describe("personaTags", () => {
  it("returns neutral defaults for empty sample", () => {
    const out = personaTags([], "white");
    expect(out.games).toBe(0);
    expect(out.aggression.label).toBe("balanced");
    expect(out.confidence.level).toBe("none");
  });

  it(`suppresses system tags below ${SYSTEM_TAG_MIN_GAMES} games`, () => {
    const london = {
      sans: ["d4", "Nf6", "Bf4", "e6", "e3"],
      ucis: ["d2d4", "g8f6", "c1f4", "e7e6", "e2e3"],
    };
    const games = [game({ ...london, gameId: "l1" })];
    const out = personaTags(games, "white");
    expect(out.systemSetup.detected).toBe(false);
    expect(out.systemSetup.label).toBeNull();
    expect(out.confidence.level).toBe("low");
  });

  it(`detects a London system when count and share clear thresholds`, () => {
    const london = {
      sans: ["d4", "Nf6", "Bf4", "e6", "e3"],
      ucis: ["d2d4", "g8f6", "c1f4", "e7e6", "e2e3"],
    };
    const other = {
      sans: ["e4", "e5", "Nf3"],
      ucis: ["e2e4", "e7e5", "g1f3"],
    };
    const games = [
      ...Array.from({ length: SYSTEM_TAG_MIN_GAMES }, (_, i) => game({ ...london, gameId: `l${i}` })),
      game({ ...other, gameId: "o1" }),
      game({ ...other, gameId: "o2" }),
    ];
    const out = personaTags(games, "white");
    expect(out.games).toBe(5);
    expect(out.systemSetup.detected).toBe(true);
    expect(out.systemSetup.label).toBe("london");
    expect(SYSTEM_TAG_MIN_GAMES / 5).toBeGreaterThanOrEqual(SYSTEM_TAG_MIN_SHARE);
  });

  it("does not tag a system when matches are too rare in a large sample", () => {
    const london = {
      sans: ["d4", "Nf6", "Bf4", "e6", "e3"],
      ucis: ["d2d4", "g8f6", "c1f4", "e7e6", "e2e3"],
    };
    const other = {
      sans: ["e4", "e5", "Nf3"],
      ucis: ["e2e4", "e7e5", "g1f3"],
    };
    const games = [
      ...Array.from({ length: SYSTEM_TAG_MIN_GAMES }, (_, i) => game({ ...london, gameId: `l${i}` })),
      ...Array.from({ length: 97 }, (_, i) => game({ ...other, gameId: `o${i}` })),
    ];
    const out = personaTags(games, "white");
    expect(out.games).toBe(100);
    expect(out.systemSetup.detected).toBe(false);
    expect(out.systemSetup.label).toBeNull();
    expect(SYSTEM_TAG_MIN_GAMES / 100).toBeLessThan(SYSTEM_TAG_MIN_SHARE);
  });

  it("does not treat Qxd5 recapture as an early queen trade", () => {
    const games = [
      game({
        color: "black",
        sans: ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5"],
        ucis: ["e2e4", "d7d5", "e4d5", "d8d5", "b1c3", "d5a5"],
        gameId: "recapture",
      }),
    ];
    const out = personaTags(games, "black");
    expect(out.tradeSpeed.queenOffPly).toBeNull();
    expect(out.tradeSpeed.label).toBe("complicator");
  });

  it("detects a true queen trade after both queens leave the board", () => {
    const games = [
      game({
        color: "white",
        sans: ["e4", "e5", "Qh5", "Nc6", "Qxe5+", "Qe7", "Qxe7+", "Nxe7"],
        ucis: ["e2e4", "e7e5", "d1h5", "b8c6", "h5e5", "d8e7", "e5e7", "c6e7"],
        gameId: "trade",
      }),
    ];
    const out = personaTags(games, "white");
    expect(out.tradeSpeed.label).toBe("simplifier");
    expect(out.tradeSpeed.queenOffPly).toBe(4);
    expect(out.castling.label).toBe("uncastled");
    expect(out.aggression.score).toBeGreaterThan(0);
  });

  it("does not label Pirc/Modern structures as Hippo", () => {
    const games = [
      game({
        color: "black",
        sans: ["e4", "d6", "Nf3", "g6", "d4", "Bg7", "Nc3", "Nf6"],
        ucis: ["e2e4", "d7d6", "g1f3", "g7g6", "d2d4", "f8g7", "b1c3", "g8f6"],
        gameId: "pirc",
      }),
    ];
    const out = personaTags(games, "black");
    expect(out.systemSetup.label).toBeNull();
    expect(out.systemSetup.detected).toBe(false);
  });

  it("detects a paired-fianchetto Hippo after enough samples", () => {
    const hippo = {
      sans: ["d4", "b6", "e4", "Bb7", "Nf3", "g6", "Bd3", "Bg7", "c4", "d6", "Nc3", "e6"],
      ucis: [
        "d2d4", "b7b6", "e2e4", "c8b7", "g1f3", "g7g6", "f1d3", "f8g7",
        "c2c4", "d7d6", "b1c3", "e7e6",
      ],
    };
    const games = Array.from({ length: SYSTEM_TAG_MIN_GAMES }, (_, i) =>
      game({ color: "black", ...hippo, gameId: `h${i}` }),
    );
    const out = personaTags(games, "black");
    expect(out.systemSetup.detected).toBe(true);
    expect(out.systemSetup.label).toBe("hippo");
  });

  it("filters by White/Black", () => {
    const games = [
      game({
        color: "white",
        sans: ["d4", "Nf6", "Bf4", "e6", "e3"],
        ucis: ["d2d4", "g8f6", "c1f4", "e7e6", "e2e3"],
      }),
      game({
        color: "black",
        sans: ["e4", "e5", "Nf3"],
        ucis: ["e2e4", "e7e5", "g1f3"],
        gameId: "b1",
      }),
    ];
    expect(personaTags(games, "white").systemSetup.detected).toBe(false);
    expect(personaTags(games, "black").systemSetup.detected).toBe(false);
  });
});

describe("scoreVsStronger", () => {
  it("returns empty buckets for empty sample", () => {
    const out = scoreVsStronger([], { color: "white" });
    expect(out.stronger.games).toBe(0);
    expect(out.equalOrLower.games).toBe(0);
    expect(out.excluded).toBe(0);
    expect(out.confidence.level).toBe("none");
  });

  it("excludes games missing either rating", () => {
    const games = [
      game({ rating: 1800, opponentRating: 0, gameId: "a" }),
      game({ rating: 0, opponentRating: 1900, gameId: "b" }),
      game({ rating: 1800, opponentRating: 1700, score: 1, gameId: "c" }),
    ];
    const out = scoreVsStronger(games, { color: "white" });
    expect(out.excluded).toBe(2);
    expect(out.equalOrLower.games).toBe(1);
    expect(out.equalOrLower.scorePct).toBe(100);
  });

  it("splits at the rating gap threshold", () => {
    const games = [
      game({ rating: 1800, opponentRating: 1950, score: 0, gameId: "strong" }),
      game({ rating: 1800, opponentRating: 1880, score: 1, gameId: "mid" }),
      game({ rating: 1800, opponentRating: 1750, score: 1, gameId: "weak" }),
    ];
    const out = scoreVsStronger(games, { color: "white", threshold: 100 });
    expect(out.stronger.games).toBe(1);
    expect(out.stronger.scorePct).toBe(0);
    expect(out.equalOrLower.games).toBe(1);
    expect(out.excluded).toBe(1);
  });

  it("filters by White/Black and speed", () => {
    const games = [
      game({ color: "white", rating: 1800, opponentRating: 2000, speed: "blitz" }),
      game({ color: "black", rating: 1800, opponentRating: 2000, speed: "rapid", gameId: "b" }),
    ];
    const white = scoreVsStronger(games, { color: "white", speedFilter: "blitz" });
    expect(white.stronger.games).toBe(1);
    const black = scoreVsStronger(games, { color: "black" });
    expect(black.stronger.games).toBe(1);
  });
});

describe("scoreBySpeed", () => {
  it("returns empty buckets for empty sample", () => {
    const out = scoreBySpeed([], { color: "white" });
    expect(out.games).toBe(0);
    expect(out.weakest).toBeNull();
    expect(out.buckets.blitz.games).toBe(0);
  });

  it("groups score by speed bucket on small sample", () => {
    const games = [
      game({ speed: "blitz", score: 1, gameId: "b1" }),
      game({ speed: "blitz", score: 0, gameId: "b2" }),
      game({ speed: "rapid", score: 0, gameId: "r1" }),
    ];
    const out = scoreBySpeed(games, { color: "white" });
    expect(out.buckets.blitz.games).toBe(2);
    expect(out.buckets.blitz.scorePct).toBe(50);
    expect(out.buckets.rapid.games).toBe(1);
    expect(out.weakest).toBeNull();
  });

  it("picks weakest speed only when a bucket clears minGames", () => {
    const games = [
      ...Array.from({ length: 3 }, (_, i) => game({ speed: "blitz", score: 1, gameId: `b${i}` })),
      ...Array.from({ length: 3 }, (_, i) => game({ speed: "rapid", score: 0, gameId: `r${i}` })),
    ];
    const out = scoreBySpeed(games, { color: "white", minGames: SPEED_BUCKET_MIN_GAMES });
    expect(out.weakest?.speed).toBe("rapid");
    expect(out.weakest?.scorePct).toBe(0);
    expect(out.weakest?.games).toBe(3);
  });

  it("filters by White/Black", () => {
    const games = [
      game({ color: "white", speed: "bullet" }),
      game({ color: "black", speed: "blitz", gameId: "b" }),
    ];
    expect(scoreBySpeed(games, { color: "white" }).buckets.bullet.games).toBe(1);
    expect(scoreBySpeed(games, { color: "black" }).buckets.blitz.games).toBe(1);
  });
});

function branchGame({
  color = "white",
  ucis,
  sans,
  score = 1,
  datestamp = 1000,
  gameId = "g1",
  totalPly = 80,
  clockAfterPly = null,
  timeControl = { baseSeconds: 180, incrementSeconds: 2 },
}) {
  return {
    color,
    score,
    sans,
    ucis,
    openingUcis: ucis,
    openingSans: sans,
    openingEndPly: ucis.length,
    totalPly,
    clockAfterPly: clockAfterPly ?? ucis.map(() => null),
    timeControl,
    nextOwnThinkSeconds: [],
    datestamp,
    speed: "blitz",
    gameId,
    rating: 1800,
    opponentRating: 1800,
  };
}

describe("aggregateOpeningBranches scoring", () => {
  const now = Date.parse("2026-06-24");

  it("weights recency, length, and fast-next-move think time", () => {
    const recentLongFast = branchGame({
      ucis: ["e2e4", "c7c5", "g1f3"],
      sans: ["e4", "c5", "Nf3"],
      datestamp: now,
      gameId: "fast",
      totalPly: 80,
      clockAfterPly: [180, 180, 180, 181, 180, 181],
    });
    const oldShortSlow = branchGame({
      ucis: ["d2d4"],
      sans: ["d4"],
      datestamp: now - 200 * 24 * 60 * 60 * 1000,
      gameId: "slow",
      totalPly: 12,
      clockAfterPly: [180, 170],
    });
    const { branches } = aggregateOpeningBranches(
      [recentLongFast, oldShortSlow],
      "white",
      { now },
    );
    const fast = branches.find((b) => b.ucis[0] === "e2e4");
    const slow = branches.find((b) => b.ucis[0] === "d2d4");
    expect(fast.branchScore).toBeGreaterThan(slow.branchScore);
  });

  it("uses neutral think-time multiplier when clocks are missing", () => {
    const withClock = branchGame({
      ucis: ["e2e4", "e7e5", "g1f3"],
      sans: ["e4", "e5", "Nf3"],
      gameId: "clk",
      clockAfterPly: [180, 180, 180, 179, 178],
    });
    const noClock = branchGame({
      ucis: ["d2d4", "d7d5", "c2c4"],
      sans: ["d4", "d5", "c4"],
      gameId: "nocl",
      timeControl: null,
      clockAfterPly: [null, null, null, null, null, null],
    });
    const { branches } = aggregateOpeningBranches([withClock, noClock], "white", { now });
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.branchScore).toBeGreaterThan(0);
    }
  });

  it("lets a single new line outrank an older repeated line", () => {
    const oldLine = branchGame({
      ucis: ["e2e4", "e7e5", "g1f3"],
      sans: ["e4", "e5", "Nf3"],
      datestamp: now - 120 * 24 * 60 * 60 * 1000,
      gameId: "old1",
      totalPly: 20,
    });
    const oldLine2 = branchGame({
      ucis: ["e2e4", "e7e5", "g1f3"],
      sans: ["e4", "e5", "Nf3"],
      datestamp: now - 150 * 24 * 60 * 60 * 1000,
      gameId: "old2",
      totalPly: 20,
    });
    const freshLine = branchGame({
      ucis: ["d2d4", "d7d5", "c2c4"],
      sans: ["d4", "d5", "c4"],
      datestamp: now,
      gameId: "new1",
      totalPly: 90,
      clockAfterPly: [180, 180, 180, 181, 180, 181],
    });
    const { branches } = aggregateOpeningBranches(
      [oldLine, oldLine2, freshLine],
      "white",
      { now },
    );
    branches.sort((a, b) => b.branchScore - a.branchScore);
    expect(branches[0].ucis[0]).toBe("d2d4");
    expect(branches.some((b) => b.line.includes("e2e4>e7e5>g1f3"))).toBe(true);
  });

  it("does not remove an old branch when a sibling branch appears", () => {
    const shared = branchGame({
      ucis: ["e2e4", "e7e5", "g1f3"],
      sans: ["e4", "e5", "Nf3"],
      gameId: "e5",
      datestamp: now - 10 * 24 * 60 * 60 * 1000,
    });
    const sibling = branchGame({
      ucis: ["e2e4", "c7c5", "g1f3"],
      sans: ["e4", "c5", "Nf3"],
      gameId: "c5",
      datestamp: now,
    });
    const { branches: before } = aggregateOpeningBranches([shared], "white", { now });
    const { branches: after } = aggregateOpeningBranches([shared, sibling], "white", { now });
    expect(after).toHaveLength(2);
    expect(after.find((b) => b.line.includes("e7e5")).games).toBe(before[0].games);
  });

  it("uses SCOUT_RECENCY_HALF_LIFE_DAYS for decay", () => {
    expect(SCOUT_RECENCY_HALF_LIFE_DAYS).toBe(90);
  });

  it("reports droppedCount for games without a valid opponent-terminal opening", () => {
    const valid = branchGame({
      ucis: ["e2e4", "e7e5", "g1f3"],
      sans: ["e4", "e5", "Nf3"],
      gameId: "ok",
    });
    const invalid = branchGame({
      ucis: ["e2e4"],
      sans: ["e4", "e5"],
      gameId: "bad",
    });
    const { branches, droppedCount } = aggregateOpeningBranches(
      [valid, invalid],
      "white",
      { now },
    );
    expect(branches).toHaveLength(1);
    expect(droppedCount).toBe(1);
  });
});

describe("buildScoutStats", () => {
  it("bundles per-color stats for report layer", () => {
    const games = [game({ color: "white" }), game({ color: "black", score: 0 })];
    const stats = buildScoutStats(games, { color: "white" });
    expect(stats.oppColor).toBe("white");
    expect(stats.scoreByFamily.games).toBe(1);
    expect(stats.activitySeries.games).toBe(1);
    expect(stats.predictability.games).toBe(1);
    expect(stats.petLineConcentration.games).toBe(1);
    expect(stats.repertoireBreadth.games).toBe(1);
    expect(stats.repertoireFreshness.games).toBe(1);
    expect(stats.repertoireChangeTrend.games).toBe(1);
    expect(stats.personaTags.games).toBe(1);
    expect(stats.formTrend).toBeUndefined();
    expect(stats.ratingTrajectory).toBeUndefined();
    expect(stats.scoreVsStronger).toBeUndefined();
  });
});