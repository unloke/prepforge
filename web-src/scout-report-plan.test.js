import { describe, expect, it } from "vitest";

import * as scoutModule from "./scout.js";
import { buildScoutSectionReport } from "./scout-report.js";
import { LOOKUPS, PLAN_GAMES } from "./scout-report-fixtures.js";

describe("scout section plan", () => {
  it("names the first moves by whose they are", () => {
    const profile = { recentlyChanged: { white: false, black: false } };
    const white = String(buildScoutSectionReport(scoutModule, { games: PLAN_GAMES, profile, username: "rival" }, "white", LOOKUPS.black, { speedFilter: "all" }).html);
    expect(white).toMatch(/rival(&#39;|&#x27;|')s first moves/);
    // With Black the distribution is White's (your) first move, not theirs.
    const blackGames = PLAN_GAMES.map((g) => ({ ...g, color: "black" }));
    const black = String(buildScoutSectionReport(scoutModule, { games: blackGames, profile, username: "rival" }, "black", LOOKUPS.white, { speedFilter: "all" }).html);
    expect(black).toContain("First moves against rival");
    expect(black).not.toMatch(/rival(&#39;|&#x27;|')s first moves/);
  });

  it("drops Add all gaps and the empty first-move heading when the plan has no rows", () => {
    const profile = { recentlyChanged: { white: false, black: false } };
    const one = PLAN_GAMES.slice(0, 1);
    const { html, sectionData } = buildScoutSectionReport(scoutModule, { games: one, profile, username: "rival" }, "white", LOOKUPS.black, { speedFilter: "all" });
    expect(sectionData.prepTargets).toHaveLength(0);
    expect(String(html)).not.toContain("scout-prepare-all");
    expect(String(html)).not.toContain("scout-first-moves");
  });
});
