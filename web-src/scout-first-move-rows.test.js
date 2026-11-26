import { describe, expect, it } from "vitest";

import { buildOpeningTrie, moveDistribution } from "./scout.js";
import { scoutDisplayDistribution, scoutDistRowHtml } from "./scout-report.js";

const DAY = 86_400_000;
const NOW = 1.7e12;
const game = (i, ageDays, score, ucis) => ({
  gameId: `g${i}`, color: "white", score, speed: "blitz", datestamp: NOW - ageDays * DAY, ucis, sans: ucis, totalPly: 40,
});
// 1.e4: five recent losses and five wins from ten months ago. 1.d4: four recent draws.
const games = [
  ...Array.from({ length: 5 }, (_, i) => game(i, 1 + i, 0, ["e2e4", "e7e5"])),
  ...Array.from({ length: 5 }, (_, i) => game(5 + i, 300, 1, ["e2e4", "c7c5"])),
  ...Array.from({ length: 4 }, (_, i) => game(10 + i, 2, 0.5, ["d2d4", "d7d5"])),
];

describe("first-move rows score the same games they count", () => {
  it("shows the games' own score next to the real game count and share", () => {
    const rows = scoutDisplayDistribution(buildOpeningTrie(games, "white"), moveDistribution);
    const e4 = rows.find((m) => m.san === "e2e4");
    expect(e4).toMatchObject({ gameCount: 10, w: 5, l: 5, scorePct: 50 });
    expect(e4.share).toBeCloseTo(10 / 14);
    // Recent form stays available, labelled as such, and is not what the row prints.
    expect(e4.recentScorePct).toBeLessThan(5);
    // The Wilson lower bound can never sit above the score it bounds.
    expect(e4.wilsonScorePct).toBeLessThanOrEqual(e4.scorePct);
    const text = String(scoutDistRowHtml(e4)).replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(text).toContain("scores 50%");
  });
});
