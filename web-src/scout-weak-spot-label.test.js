import { describe, expect, it } from "vitest";

import { rankGamePlan, SCOUT_ATTACK_MIN_MARGIN } from "./scout.js";
import { buildScoutStats } from "./scout-stats.js";
import { buildScoutSectionSummary } from "./scout-summary.js";

const ucis = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6"];
const sans = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"];
// A well-supported route whose recency-weighted baseline (56%) differs from the
// whole-history one the section header shows (50%).
const route = (maiaScorePct) => ({
  ucis, sans, line: ucis.join(">"), games: 12, routeSupportGames: 12, evidenceGames: 40, share: 0.3, scorePct: 50,
  maiaScorePct, routeReach: 0.6, evidencePlies: 8, anchorUcis: ucis, continuationShare: 1,
  pathGames: [40, 30, 30, 20, 20, 12, 12, 12],
  preparationDecisions: [
    { ply: 2, moveGames: 30, parentGames: 40 }, { ply: 4, moveGames: 20, parentGames: 30 },
    { ply: 6, moveGames: 12, parentGames: 20 }, { ply: 8, moveGames: 12, parentGames: 12 },
  ],
  selectionBaseline: { score: 0.56 },
});

describe("weak-spot badge uses the selection's own baseline and gap", () => {
  it("does not badge a sliver as a weak spot, nor invent a 1-point gap", () => {
    // 52% is 4 points under the 56% the selector used: valued, but below the margin.
    const [r] = rankGamePlan([route(52)], 50, { oppColor: "black" });
    expect(r.preparationEvidence.value).toBeGreaterThan(0);
    expect(r.prepCategory).toBe("neutral");
    expect(r.belowBaseline).toBe(0);
  });

  it("reports the honest gap against the baseline it was measured by", () => {
    const [r] = rankGamePlan([route(49)], 50, { oppColor: "black" });
    expect(r.prepCategory).toBe("attack");
    expect(r.weakSpotBaselinePct).toBe(56);
    expect(r.belowBaseline).toBe(7);
    expect(r.belowBaseline).toBeGreaterThanOrEqual(SCOUT_ATTACK_MIN_MARGIN);
  });

  it("calls a line Maia rates well above that baseline a main line", () => {
    const [r] = rankGamePlan([route(70)], 50, { oppColor: "black" });
    expect(r.prepCategory).toBe("weapon");
    expect(r.belowBaseline).toBe(0);
  });

  it("headline quotes Maia's estimate and its baseline, not the games' own score", () => {
    const [top] = rankGamePlan([{ ...route(30), scorePct: 80, routeScorePct: 80 }], 50, { oppColor: "black" });
    const games = Array.from({ length: 12 }, (_, i) => ({ gameId: `g${i}`, color: "black", score: 1, ucis, sans, speed: "blitz" }));
    const out = buildScoutSectionSummary(buildScoutStats(games, { color: "black" }), { username: "X", prepTargets: [top] });
    expect(out.headline).toMatch(/Maia/);
    expect(out.headline).toMatch(/30%/);
    expect(out.headline).toMatch(/56%/);
    expect(out.headline).not.toMatch(/80%/);
  });
});
