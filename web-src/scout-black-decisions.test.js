import { describe, expect, it } from "vitest";

import { opponentProfile } from "./scout.js";
import { buildScoutStats, predictability, repertoireBreadth, repertoireFreshness } from "./scout-stats.js";
import { buildScoutSectionSummary } from "./scout-summary.js";
import { decisionGroups, decisionSpread } from "./scout-decisions.js";

const DAY = 86_400_000;
const E4 = { ucis: ["e2e4", "c7c5", "g1f3"], sans: ["e4", "c5", "Nf3"] };
const D4 = { ucis: ["d2d4", "g8f6", "c2c4"], sans: ["d4", "Nf6", "c4"] };
const E4_E5 = { ucis: ["e2e4", "e7e5", "g1f3"], sans: ["e4", "e5", "Nf3"] };

// Newest first, like the Lichess export.
const game = (i, line, color = "black") => ({
  gameId: `g${i}`, color, score: 0.5, speed: "blitz", datestamp: 1.7e12 - i * DAY, totalPly: 40, rating: 1800, ...line,
});

// A Black player with a fixed repertoire (1…c5 to 1.e4, 1…Nf6 to 1.d4) whose OPPONENTS
// switched from mostly 1.d4 (older games) to mostly 1.e4 (newest games).
const opponentsSwitched = () =>
  Array.from({ length: 40 }, (_, i) => game(i, (i < 20) === (i % 10 !== 0) ? E4 : D4));

describe("Black's first decision is their reply to the first move they face", () => {
  it("reads a fixed Black repertoire as predictable and unchanged", () => {
    const games = opponentsSwitched();
    const stats = buildScoutStats(games, { color: "black" });
    expect(stats.predictability.label).toBe("predictable");
    expect(stats.predictability.topShare).toBe(1);
    expect(stats.predictability.normalized).toBe(0);
    expect(stats.predictability.topMove).toMatchObject({ faced: { san: expect.any(String) }, label: expect.stringMatching(/^1\. /) });
    expect(stats.repertoireChangeTrend.points.every((p) => p === 100)).toBe(true);
    expect(stats.repertoireChangeTrend.trend).toBe("flat");
    expect(repertoireBreadth(games, "black").moves.map((m) => m.label).sort()).toEqual(["1. d4 Nf6", "1. e4 c5"]);
    expect(opponentProfile(games).recentlyChanged.black).toBe(false);
  });

  it("names Black's replies in the headline, never White's most common first move", () => {
    const stats = buildScoutStats(opponentsSwitched(), { color: "black" });
    const target = { sans: ["e4", "c5"], ucis: ["e2e4", "c7c5"], prepCategory: "attack", routeSupportGames: 12, routeScorePct: 40, share: 0.5 };
    const summary = buildScoutSectionSummary(stats, { username: "X", prepTargets: [target] });
    expect(summary.headline).toMatch(/^Predictable replies: 1… (c5|Nf6) to 1\. (e4|d4)/);
    expect(summary.headline).not.toMatch(/Mostly 1\.|Predictable 1\./);
    expect(summary.bullets.join(" ")).not.toMatch(/Hard to guess|Varied first moves|experimenting/);
  });

  it("still sees a real change of reply, against the same first move", () => {
    // Newest 20: 1…e5 to 1.e4; older 20: 1…c5 to 1.e4.
    const games = Array.from({ length: 40 }, (_, i) => game(i, i < 20 ? E4_E5 : E4));
    expect(opponentProfile(games).recentlyChanged.black).toBe(true);
    const fresh = repertoireFreshness(games, "black", { recentWindow: 20, previousWindow: 20 });
    expect(fresh.freshFamilies.map((f) => f.label)).toEqual(["1. e4 e5"]);
    expect(predictability(games, "black").label).not.toBe("predictable");
  });

  it("does not call a reply new when they never faced that first move before", () => {
    // Newest games bring 1.d4 for the first time; their reply to it is untested, not new.
    const games = Array.from({ length: 40 }, (_, i) => game(i, i < 20 ? D4 : E4));
    expect(repertoireFreshness(games, "black", { recentWindow: 20, previousWindow: 20 }).freshFamilies).toEqual([]);
    expect(opponentProfile(games).recentlyChanged.black).toBe(false);
  });

  it("windows each colour on its own games, so a mostly-White history still checks Black", () => {
    const white = Array.from({ length: 60 }, (_, i) => game(100 + i, { ucis: ["e2e4"], sans: ["e4"] }, "white"));
    const black = Array.from({ length: 24 }, (_, i) => game(i, i < 12 ? E4_E5 : E4));
    // Interleave: the newest 40 games overall are mostly White.
    const games = [...white.slice(0, 30), ...black, ...white.slice(30)];
    expect(opponentProfile(games).recentlyChanged).toEqual({ white: false, black: true });
  });

  it("keeps White's measures unchanged: one group over the first move", () => {
    const games = [
      ...Array.from({ length: 12 }, (_, i) => game(i, { ucis: ["d2d4"], sans: ["d4"] }, "white")),
      game(12, { ucis: ["d2d3"], sans: ["d3"] }, "white"),
    ];
    const spread = decisionSpread(decisionGroups(games, "white"), { minGames: 3 });
    expect(spread.topShare).toBeCloseTo(12 / 13);
    expect(predictability(games, "white")).toMatchObject({ label: "predictable", topMove: { san: "d4" } });
  });
});
