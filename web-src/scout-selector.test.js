import { describe, expect, it } from "vitest";

import {
  PRODUCTION_MODULE_B,
  PRODUCTION_MODULE_B_ID,
  PRODUCTION_ROUTE_BUDGET,
  getProductionModuleB,
  selectProductionRoutes,
} from "./scout-selector.js";
import {
  SCOUT_GAME_PLAN_LIMIT,
  SCOUT_SCORING_VERSION,
  opponentProfile,
  rankGamePlan,
  rankedOpeningBranches,
  terminalMoveIsOpponent,
} from "./scout.js";
import { buildScoutSectionReport } from "./scout-report.js";
import * as scoutModule from "./scout.js";

function scoutGame({
  color = "white",
  score = 1,
  sans,
  ucis,
  rating = 1800,
  datestamp = 1_700_000_000_000,
  speed = "blitz",
  gameId = "g",
} = {}) {
  return {
    color,
    score,
    sans,
    ucis,
    openingUcis: ucis,
    openingSans: sans,
    openingEndPly: ucis.length,
    rating,
    datestamp,
    speed,
    gameId,
    result: "1-0",
  };
}

function makeCorpus() {
  const games = [];
  for (let i = 0; i < 20; i += 1) {
    games.push(
      scoutGame({
        gameId: `sicilian-${i}`,
        score: i % 3 === 0 ? 0 : 1,
        sans: ["e4", "c5", "Nf3"],
        ucis: ["e2e4", "c7c5", "g1f3"],
        datestamp: 1_700_000_000_000 - i * 86_400_000,
      }),
    );
  }
  for (let i = 0; i < 12; i += 1) {
    games.push(
      scoutGame({
        gameId: `french-${i}`,
        score: 0,
        sans: ["e4", "e6", "d4"],
        ucis: ["e2e4", "e7e6", "d2d4"],
        datestamp: 1_700_000_000_000 - i * 86_400_000,
      }),
    );
  }
  for (let i = 0; i < 8; i += 1) {
    games.push(
      scoutGame({
        gameId: `caro-${i}`,
        score: 0.5,
        sans: ["e4", "c6", "d4"],
        ucis: ["e2e4", "c7c6", "d2d4"],
        datestamp: 1_700_000_000_000 - i * 86_400_000,
      }),
    );
  }
  for (let i = 0; i < 6; i += 1) {
    games.push(
      scoutGame({
        color: "black",
        gameId: `black-e5-${i}`,
        score: 0,
        sans: ["e4", "e5", "Nf3", "Nc6"],
        ucis: ["e2e4", "e7e5", "g1f3", "b8c6"],
        datestamp: 1_700_000_000_000 - i * 86_400_000,
      }),
    );
  }
  return games;
}

describe("production Module B contract (Scout v2)", () => {
  it("names Scout v2 as the production selector with exact budget 12", () => {
    expect(PRODUCTION_MODULE_B.id).toBe("scout-v2");
    expect(PRODUCTION_MODULE_B_ID).toBe("scout-v2");
    expect(PRODUCTION_MODULE_B.researchOnly).toBe(false);
    expect(PRODUCTION_ROUTE_BUDGET).toBe(12);
    expect(PRODUCTION_ROUTE_BUDGET).toBe(SCOUT_GAME_PLAN_LIMIT);
    expect(PRODUCTION_MODULE_B.scoringVersion).toBe(SCOUT_SCORING_VERSION);
    expect(getProductionModuleB().select).toBe(selectProductionRoutes);
  });

  it("selects at most the exact route budget and is deterministic", () => {
    const games = makeCorpus();
    const { branches } = rankedOpeningBranches(games, "white");
    const first = selectProductionRoutes(branches, 50, { oppColor: "white", games });
    const second = selectProductionRoutes(branches, 50, { oppColor: "white", games });
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(PRODUCTION_ROUTE_BUDGET);
    expect(first.map((r) => r.line || r.ucis.join(">"))).toEqual(
      second.map((r) => r.line || r.ucis.join(">")),
    );
    expect(first).toEqual(rankGamePlan(branches, 50, { oppColor: "white", games }));
  });

  it("normalizes each selected route so the terminal ply is the opponent's move", () => {
    const games = makeCorpus();
    for (const color of ["white", "black"]) {
      const { branches } = rankedOpeningBranches(games, color);
      const selected = selectProductionRoutes(branches, 50, { oppColor: color, games });
      expect(selected.length).toBeGreaterThan(0);
      for (const route of selected) {
        expect(terminalMoveIsOpponent(route.ucis, color)).toBe(true);
        expect(Array.isArray(route.ucis)).toBe(true);
        expect(route.ucis.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps distinct opponent-terminal routes that share only the first 16 plies", () => {
    const shared = Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? "e2e4" : "e7e5"));
    // Legal-looking unique tails after the shared display-trie prefix.
    const a = {
      line: [...shared, "a17"].join(">"),
      ucis: [...shared, "a17"],
      sans: [...shared, "a17"],
      games: 2,
      share: 0.2,
      branchScore: 2,
      scorePct: 25,
      w: 0,
      d: 0,
      l: 2,
    };
    const b = {
      line: [...shared, "b17"].join(">"),
      ucis: [...shared, "b17"],
      sans: [...shared, "b17"],
      games: 2,
      share: 0.2,
      branchScore: 1,
      scorePct: 25,
      w: 0,
      d: 0,
      l: 2,
    };
    const selected = selectProductionRoutes([a, b], 50, { oppColor: "white" });
    expect(selected).toHaveLength(2);
    expect(new Set(selected.map((r) => r.ucis.join(">"))).size).toBe(2);
  });

  it("breaks remaining ties by line key so identical stats replay in one order", () => {
    const twinA = {
      line: "e2e4>e7e5",
      ucis: ["e2e4", "e7e5"],
      sans: ["e4", "e5"],
      games: 2,
      share: 0.25,
      branchScore: 1,
      scorePct: 40,
      w: 0,
      d: 0,
      l: 2,
    };
    const twinB = {
      line: "d2d4>d7d5",
      ucis: ["d2d4", "d7d5"],
      sans: ["d4", "d5"],
      games: 2,
      share: 0.25,
      branchScore: 1,
      scorePct: 40,
      w: 0,
      d: 0,
      l: 2,
    };
    const first = selectProductionRoutes([twinB, twinA], 50, { oppColor: "white" });
    const second = selectProductionRoutes([twinA, twinB], 50, { oppColor: "white" });
    const keys = first.map((r) => r.ucis.join(">"));
    expect(keys).toEqual(second.map((r) => r.ucis.join(">")));
    expect(keys[0] < keys[1]).toBe(true);
  });

  it("does not read Result or future-labelled fields from candidate rows", () => {
    const games = makeCorpus();
    const { branches } = rankedOpeningBranches(games, "white");
    const poisoned = branches.map((b, i) => ({
      ...b,
      Result: i % 2 === 0 ? "0-1" : "1-0",
      futureResult: 1,
      holdoutLabel: "win",
    }));
    const clean = selectProductionRoutes(branches, 50, { oppColor: "white", games });
    const dirty = selectProductionRoutes(poisoned, 50, { oppColor: "white", games });
    expect(dirty.map((r) => r.ucis.join(">"))).toEqual(clean.map((r) => r.ucis.join(">")));
  });

  it("section report ranks with the opening trie exploitability prior, not raw frequency", () => {
    const games = makeCorpus().filter((g) => g.color === "white");
    const { sectionData } = buildScoutSectionReport(
      scoutModule,
      { games, profile: opponentProfile(games), username: "acceptance" },
      "white",
      [],
      { username: "acceptance", escapeHtml: (s) => String(s) },
    );
    expect(sectionData.prepTargets.some((t) => t.exploitabilityPrior != null)).toBe(true);
  });

  it("section report uses the production selector and stays within budget", () => {
    const games = makeCorpus().filter((g) => g.color === "white");
    const { html, sectionData } = buildScoutSectionReport(
      scoutModule,
      { games, profile: opponentProfile(games), username: "acceptance" },
      "white",
      [],
      { username: "acceptance", escapeHtml: (s) => String(s) },
    );
    expect(html).toContain("scout-section");
    expect(html).toContain(`data-module-b="${PRODUCTION_MODULE_B_ID}"`);
    expect(sectionData.moduleB).toBe(PRODUCTION_MODULE_B_ID);
    expect(sectionData.prepTargets.length).toBeGreaterThan(0);
    expect(sectionData.prepTargets.length).toBeLessThanOrEqual(PRODUCTION_ROUTE_BUDGET);
    for (const target of sectionData.prepTargets) {
      expect(terminalMoveIsOpponent(target.ucis, "white")).toBe(true);
    }
  });
});
