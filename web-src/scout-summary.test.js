import { describe, expect, it } from "vitest";

import { buildColorRecommendationBanner, buildScoutSectionSummary } from "./scout-summary.js";
import { buildExplorerReads } from "./scout-explorer.js";
import { fenAfterLine } from "./scout.js";
import { buildScoutStats } from "./scout-stats.js";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function game(overrides = {}) {
  return {
    color: "white",
    score: 0,
    sans: ["d4"],
    ucis: ["d2d4"],
    rating: 1800,
    opponentRating: 1800,
    datestamp: 1000,
    speed: "blitz",
    gameId: "g1",
    ...overrides,
  };
}

describe("buildScoutSectionSummary", () => {
  it("returns empty headline for empty stats input", () => {
    const out = buildScoutSectionSummary(null);
    expect(out.headline).toBe("");
    expect(out.bullets).toEqual([]);
  });

  it("headline uses prep target when sufficiently sampled", () => {
    const prepTargets = [
      {
        sans: ["d4", "d5"],
        ucis: ["d2d4", "d7d5"],
        games: 21,
        scorePct: 28,
        share: 0.35,
        prepCategory: "attack",
        belowBaseline: 22,
      },
    ];
    const games = Array.from({ length: 21 }, (_, i) =>
      game({ score: i % 3 === 0 ? 1 : 0, san: "d4", ucis: ["d2d4", "d7d5"], gameId: `d${i}` }),
    );
    const stats = buildScoutStats(games, { color: "white" });
    const out = buildScoutSectionSummary(stats, { username: "foe", prepTargets });
    expect(out.headline).toMatch(/hit them|punish/i);
    expect(out.headline).toMatch(/28%/);
    expect(out.headline).toMatch(/21/);
  });

  it("includes repertoire shift bullet when trend points exist", () => {
    const games = Array.from({ length: 12 }, (_, i) =>
      game({
        score: i % 2,
        san: i < 6 ? "e4" : "d4",
        ucis: i < 6 ? ["e2e4"] : ["d2d4"],
        gameId: `g${i}`,
        datestamp: 1000 + i * 1000,
      }),
    );
    const stats = buildScoutStats(games, { color: "white" });
    const out = buildScoutSectionSummary(stats);
    expect(out.bullets.some((b) => /Opening mix|First-move repertoire|concentrat|experiment/i.test(b))).toBe(
      true,
    );
  });

  it("includes repertoire read bullets from stats only", () => {
    const games = Array.from({ length: 9 }, (_, i) =>
      game({ san: "e4", ucis: ["e2e4"], gameId: `e${i}`, datestamp: 5000 - i }),
    );
    const stats = buildScoutStats(games, { color: "white" });
    const out = buildScoutSectionSummary(stats);
    expect(out.bullets.some((b) => /predictably|First move is usually/i.test(b))).toBe(true);
    // The helper's default SAN is d4 (only the UCI is overridden above).
    expect(out.bullets.some((b) => /Expect 1\. \w+ \(100%\)/.test(b))).toBe(true);
  });

  it("never asks whether a full game line repeats (deep lines are always n=1)", () => {
    const games = Array.from({ length: 40 }, (_, i) =>
      game({ score: i % 2, san: "e4", ucis: ["e2e4", "e7e5"], sans: ["e4", "e5"], gameId: `g${i}` }),
    );
    const stats = buildScoutStats(games, { color: "white" });
    const prepTargets = [{ sans: ["e4", "e5"], ucis: ["e2e4", "e7e5"], games: 1, scorePct: 0 }];
    const out = buildScoutSectionSummary(stats, { username: "foe", prepTargets });
    expect(out.headline).not.toMatch(/repeats enough|Load more games/);
    expect(out.headline).toMatch(/Expect 1\. e4 \(100%\)/);
    expect(out.headline).toMatch(/50% average/);
  });

  it("leads with a well-sampled weak opening branch", () => {
    const games = [
      ...Array.from({ length: 60 }, (_, i) =>
        game({ score: i < 48 ? 1 : 0, ucis: ["e2e4", "e7e5"], sans: ["e4", "e5"], gameId: `a${i}` }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        game({ score: i < 8 ? 1 : 0, ucis: ["e2e4", "c7c5"], sans: ["e4", "c5"], gameId: `b${i}` }),
      ),
    ];
    const stats = buildScoutStats(games, { color: "white" });
    const out = buildScoutSectionSummary(stats, { username: "foe" });
    // 1...c5 is the preparing (Black) player's own move, so it's something to steer into.
    expect(out.headline).toBe("Steer toward 1. e4 c5: foe scores 20% there over 40 games, against 56% overall.");
    expect(out.notes.some((n) => /Their best ground: 1\. e4 e5/.test(n))).toBe(true);
  });

  it("keeps the top weak branch in the notes when the headline is taken by a prep target", () => {
    // Same shape as above: 1.e4 c5 is clearly their weak branch. But a prep
    // target with enough games owns the headline — weak[0] must NOT vanish.
    const games = [
      ...Array.from({ length: 60 }, (_, i) =>
        game({ score: i < 48 ? 1 : 0, ucis: ["e2e4", "e7e5"], sans: ["e4", "e5"], gameId: `a${i}` }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        game({ score: i < 8 ? 1 : 0, ucis: ["e2e4", "c7c5"], sans: ["e4", "c5"], gameId: `b${i}` }),
      ),
    ];
    const stats = buildScoutStats(games, { color: "white" });
    const prepTargets = [
      { sans: ["e4", "e5"], ucis: ["e2e4", "e7e5"], games: 60, scorePct: 80, belowBaseline: 24 },
    ];
    const out = buildScoutSectionSummary(stats, { username: "foe", prepTargets });
    expect(out.headline).toMatch(/hit them in|punish/);
    expect(out.notes.some((n) => /1\. e4 c5/.test(n))).toBe(true);
  });

  it("does not surface rating, form, or speed bullets", () => {
    const games = [
      ...Array.from({ length: 3 }, (_, i) =>
        game({
          rating: 1800,
          opponentRating: 1950,
          score: 0,
          speed: "blitz",
          gameId: `s${i}`,
        }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        game({
          rating: 1800,
          opponentRating: 1750,
          score: 1,
          speed: "rapid",
          gameId: `r${i}`,
        }),
      ),
    ];
    const stats = buildScoutStats(games, { color: "white" });
    const out = buildScoutSectionSummary(stats);
    expect(out.bullets.some((b) => /stronger opponents|higher-rated foes/i.test(b))).toBe(false);
    expect(out.bullets.some((b) => /Weakest in blitz|Their blitz score/i.test(b))).toBe(false);
    expect(out.bullets.some((b) => /Rating climbing|Rolling score/i.test(b))).toBe(false);
  });

  it("includes explorer bullets when reads are available", () => {
    const startFen = fenAfterLine([]);
    const explorerReads = buildExplorerReads(
      [
        {
          fen: startFen,
          parentUcis: [],
          moveUci: "g1f3",
          moveSan: "Nf3",
          opponentShare: 0.4,
          opponentGames: 4,
          opponentScorePct: 60,
          ply: 1,
        },
      ],
      {
        mastersByFen: new Map([
          [
            startFen,
            {
              totalGames: 10_000,
              moves: [
                { uci: "e2e4", san: "e4", share: 0.45, total: 4500 },
                { uci: "g1f3", san: "Nf3", share: 0.1, total: 1000 },
              ],
            },
          ],
        ]),
        poolByFen: new Map([
          [
            startFen,
            {
              totalGames: 10_000,
              moves: [
                { uci: "e2e4", san: "e4", share: 0.45, total: 4500 },
                { uci: "g1f3", san: "Nf3", share: 0.2, total: 2000 },
              ],
            },
          ],
        ]),
      },
    );
    const stats = buildScoutStats([game()], { color: "white" });
    const out = buildScoutSectionSummary(stats, {
      explorerReads: { available: true, ...explorerReads },
    });
    expect(out.bullets.some((b) => /theory|masters/i.test(b))).toBe(true);
    expect(out.bullets.some((b) => /pool comparison/i.test(b))).toBe(false);
  });

  it("does not treat sparse historical buckets as consecutive recent weeks", () => {
    const y2022 = Date.parse("2022-06-01");
    const y2024 = Date.parse("2024-06-01");
    const y2026 = Date.parse("2026-06-01");
    const games = [
      game({ datestamp: y2022, gameId: "a" }),
      game({ datestamp: y2024, gameId: "b" }),
      game({ datestamp: y2026, gameId: "c" }),
    ];
    const stats = buildScoutStats(games, { color: "white" });
    const activityLine = stats.activitySeries;
    expect(activityLine.recentGames).toBe(1);
    const out = buildScoutSectionSummary(stats);
    expect(out.bullets.some((b) => b.includes("3 games in recent weeks"))).toBe(false);
    expect(out.bullets.some((b) => /1 White game in the last 3 weeks/i.test(b))).toBe(true);
  });
});

describe("buildColorRecommendationBanner", () => {
  it("returns empty string when no recommendation", () => {
    expect(buildColorRecommendationBanner(null, escapeHtml)).toBe("");
  });

  it("renders insufficient comparison banner without a pick", () => {
    const html = buildColorRecommendationBanner(
      {
        insufficient: true,
        pick: null,
        whiteGames: 15,
        blackGames: 1,
        confidence: { level: "low", label: "low confidence", n: 1 },
      },
      escapeHtml,
    );
    expect(html).toContain("Too few games to compare colours");
    expect(html).not.toContain("take White");
    expect(html).not.toContain("()");
  });

  it("renders pick banner with escaped html", () => {
    const html = buildColorRecommendationBanner(
      {
        pick: "white",
        theirWeakColor: "black",
        weakScore: 35,
        otherScore: 55,
        confidence: { level: "medium", label: "moderate confidence", n: 10 },
      },
      escapeHtml,
    );
    expect(html).toContain("scout-color-rec");
    expect(html).toContain("White");
    expect(html).not.toContain("<script");
  });
});

describe("colour banner wording", () => {
  const escapeHtml = (s) => String(s).replace(/</g, "&lt;");
  it("never prints an empty () for a confident even read, and names the player", () => {
    const html = buildColorRecommendationBanner(
      { pick: null, theirWeakColor: null, weakScore: 80, otherScore: 81, confidence: { level: "high", n: 300 } },
      escapeHtml,
      { username: "rival" },
    );
    expect(html).not.toContain("()");
    expect(html).toContain("rival");
  });
});
