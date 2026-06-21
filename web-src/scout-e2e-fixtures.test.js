import { describe, expect, it } from "vitest";

import {
  SCOUT_E2E_REFUTATION_SCENARIOS,
  buildE2ePrepSection,
  scoutE2eSeedGames,
} from "./scout-e2e-fixtures.js";
import { collectActionableRefutationGapActions } from "./scout-refutation.js";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

describe("scout-e2e-fixtures", () => {
  it("confirmedHit always produces a refutation with Play suggestion", () => {
    const { refutations } = SCOUT_E2E_REFUTATION_SCENARIOS.confirmedHit;
    const hits = refutations.filter((r) => r.refutation);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].refutation.suggestedUci).toBe("b1c3");
    expect(collectActionableRefutationGapActions(refutations)).toEqual([]);
  });

  it("deepScanGap always surfaces the deep-scan CTA", () => {
    const { refutations } = SCOUT_E2E_REFUTATION_SCENARIOS.deepScanGap;
    expect(refutations.every((r) => !r.refutation)).toBe(true);
    const actions = collectActionableRefutationGapActions(refutations);
    expect(actions.map((a) => a.id)).toEqual(["deep-scan"]);
    expect(actions[0].testId).toBe("scout-refutation-gap-deep-scan");
  });

  it("oauthGap refutations still produce engine replies without explorer", () => {
    const { refutations } = SCOUT_E2E_REFUTATION_SCENARIOS.oauthGap;
    const hits = refutations.filter((r) => r.refutation);
    expect(hits.length).toBeGreaterThan(0);
    expect(collectActionableRefutationGapActions(refutations)).toEqual([]);
  });

  it("seed games satisfy deep-scan guard", () => {
    const games = scoutE2eSeedGames();
    expect(games.length).toBeGreaterThanOrEqual(10);
    expect(games.some((g) => g.color === "black")).toBe(true);
  });

  it("buildE2ePrepSection renders inline refutation card without OAuth", () => {
    const { html, sectionData } = buildE2ePrepSection("enginePrepCard", escapeHtml);
    expect(html).toContain("Your game plan");
    expect(html).toContain("scout-refutation-card");
    expect(html).toContain("You answer");
    expect(sectionData.prepTargets?.some((t) => t.refutation)).toBe(true);
  });

  it("buildE2ePrepSection deepScanGap surfaces deep-scan CTA in prep column", () => {
    const { html } = buildE2ePrepSection("deepScanGap", escapeHtml);
    expect(html).toContain("scout-refutation-gap-deep-scan");
    expect(html).not.toContain("scout-refutation-card");
  });
});