import { describe, expect, it } from "vitest";

import {
  CONCEPT_FAMILY_BY_FEATURE,
  CONCEPT_FAMILY_CENTER_STRATEGY,
  CONCEPT_FAMILY_PAWN_STRUCTURE,
  HIGH_VARIANCE_EVAL_SWING_MIN_CP,
  MEM_MAX_CONCEPT_FAMILIES,
  MEM_MAX_FORKS,
  MEM_MAX_LEAVES,
  MEM_MAX_ONLY_MOVE_NON_FORCING,
  MEM_MAX_REPLIES_PER_FORK,
  MEM_MAX_REPLIES_PER_FORK_WARN,
  MEM_PENALTY_CONCEPT_COEF,
  MEM_PENALTY_FORK_COEF,
  MEM_PENALTY_ONLY_MOVE_COEF,
  MEM_PENALTY_TRANSPOSITION_COEF,
  RARE_HIGH_VOLUME_GAMES,
  RISK_BADGE_COHORT_ONLY,
  RISK_BADGE_HIGH_VARIANCE,
  RISK_BADGE_LOW_THEORY,
  RISK_BADGE_NARROW,
  RISK_BADGE_THIN_SAMPLE,
  RISK_BADGE_TRANSPOSITIONS,
  checkMemorabilityBudget,
  classifyStyles,
  conceptFamiliesForEdges,
  deriveRiskBadges,
  memPenalty,
} from "./scout-v13-style.js";

/** @returns {import("./scout-v13-style.js").StyleMetrics} */
function baseMetrics(overrides = {}) {
  return {
    endpointEvalCp: 20,
    ourGaps: [10, 12],
    evalSwingCp: 50,
    hasSacrifice: false,
    anchorAttribution: 0.2,
    attributionP75: 0.8,
    leakMoveIsCaptureOrCheck: false,
    onlyMoveCount: 0,
    entryMoveExplorerSharePct: 40,
    entryNodeTotalGames: 5000,
    goodRepliesWithin50Cp: 5,
    checkCaptureThreatDensity: 0.2,
    topTwoRepliesCoveragePct: 50,
    ...overrides,
  };
}

/** @returns {import("./scout-v13-style.js").MemorabilityTree} */
function validTree(overrides = {}) {
  return {
    leafCount: 4,
    forkCount: 2,
    maxRepliesPerFork: 2,
    onlyMoveCount: 2,
    conceptFamilies: ["development", "pawnStructure"],
    style: "solid",
    ...overrides,
  };
}

describe("classifyStyles", () => {
  it("qualifies solid only with a near-miss on gap", () => {
    const solidOnly = baseMetrics({
      endpointEvalCp: 20,
      ourGaps: [10, 12],
      evalSwingCp: 50,
      hasSacrifice: false,
    });
    expect(classifyStyles(solidOnly)).toEqual({ styles: ["solid"], primary: "solid" });

    const nearMiss = baseMetrics({ ourGaps: [10, 16] });
    expect(classifyStyles(nearMiss).styles).not.toContain("solid");
  });

  it("qualifies sharp only with a near-miss on gap", () => {
    const sharpOnly = baseMetrics({
      endpointEvalCp: 10,
      ourGaps: [18],
      evalSwingCp: 90,
      anchorAttribution: 0.9,
      attributionP75: 0.8,
      leakMoveIsCaptureOrCheck: true,
    });
    expect(classifyStyles(sharpOnly)).toEqual({ styles: ["sharp"], primary: "sharp" });

    const nearMiss = baseMetrics({
      ourGaps: [21],
      evalSwingCp: 90,
      anchorAttribution: 0.9,
      attributionP75: 0.8,
      leakMoveIsCaptureOrCheck: true,
    });
    expect(classifyStyles(nearMiss).styles).not.toContain("sharp");
  });

  it("qualifies rare only with a near-miss on share at normal volume", () => {
    const rareOnly = baseMetrics({
      endpointEvalCp: 10,
      ourGaps: [20],
      entryMoveExplorerSharePct: 3,
      entryNodeTotalGames: 5000,
    });
    expect(classifyStyles(rareOnly)).toEqual({ styles: ["rare"], primary: "rare" });

    const nearMiss = baseMetrics({
      ourGaps: [20],
      entryMoveExplorerSharePct: 8,
      entryNodeTotalGames: 5000,
    });
    expect(classifyStyles(nearMiss).styles).not.toContain("rare");
  });

  it("relaxes rare share threshold at high volume", () => {
    const relaxed = baseMetrics({
      ourGaps: [20],
      entryMoveExplorerSharePct: 8,
      entryNodeTotalGames: 15000,
    });
    expect(classifyStyles(relaxed).styles).toContain("rare");

    const atThreshold = baseMetrics({
      ourGaps: [20],
      entryMoveExplorerSharePct: 8,
      entryNodeTotalGames: RARE_HIGH_VOLUME_GAMES,
    });
    expect(classifyStyles(atThreshold).styles).toContain("rare");
  });

  it("qualifies forcing only with a near-miss on good replies", () => {
    const forcingOnly = baseMetrics({
      endpointEvalCp: 10,
      ourGaps: [20],
      entryMoveExplorerSharePct: 40,
      goodRepliesWithin50Cp: 2,
      checkCaptureThreatDensity: 0.6,
      topTwoRepliesCoveragePct: 70,
    });
    expect(classifyStyles(forcingOnly)).toEqual({ styles: ["forcing"], primary: "forcing" });

    const nearMiss = baseMetrics({
      goodRepliesWithin50Cp: 3,
      checkCaptureThreatDensity: 0.6,
      topTwoRepliesCoveragePct: 70,
    });
    expect(classifyStyles(nearMiss).styles).not.toContain("forcing");
  });

  it("prefers sharp over solid when both qualify", () => {
    const both = baseMetrics({
      endpointEvalCp: 20,
      ourGaps: [10, 14],
      evalSwingCp: 50,
      hasSacrifice: false,
      anchorAttribution: 0.9,
      attributionP75: 0.8,
      leakMoveIsCaptureOrCheck: true,
      onlyMoveCount: 1,
    });
    const result = classifyStyles(both);
    expect(result.styles).toEqual(expect.arrayContaining(["solid", "sharp"]));
    expect(result.primary).toBe("sharp");
  });

  it("prefers forcing over rare when both qualify", () => {
    const both = baseMetrics({
      endpointEvalCp: 10,
      ourGaps: [20],
      entryMoveExplorerSharePct: 4,
      entryNodeTotalGames: 5000,
      goodRepliesWithin50Cp: 2,
      checkCaptureThreatDensity: 0.6,
      topTwoRepliesCoveragePct: 70,
    });
    const result = classifyStyles(both);
    expect(result.styles).toEqual(expect.arrayContaining(["rare", "forcing"]));
    expect(result.primary).toBe("forcing");
  });

  it("returns empty when no style qualifies", () => {
    const none = baseMetrics({
      endpointEvalCp: 5,
      ourGaps: [30],
      evalSwingCp: 200,
      hasSacrifice: true,
      entryMoveExplorerSharePct: 50,
      goodRepliesWithin50Cp: 5,
      checkCaptureThreatDensity: 0.1,
      topTwoRepliesCoveragePct: 40,
    });
    expect(classifyStyles(none)).toEqual({ styles: [], primary: null });
  });
});

describe("deriveRiskBadges", () => {
  const clean = {
    personalEdgeGames: [12, 20],
    extensionHasPersonal: true,
    onlyMoveCount: 0,
    evalSwingCp: 50,
    primaryStyle: "solid",
    entryTransposes: false,
  };

  it("returns no badges for a clean package", () => {
    expect(deriveRiskBadges(clean)).toEqual([]);
  });

  it("flags ThinSample when a personal edge has 5–9 games", () => {
    expect(deriveRiskBadges({ ...clean, personalEdgeGames: [12, 7] })).toContain(
      RISK_BADGE_THIN_SAMPLE,
    );
    expect(deriveRiskBadges({ ...clean, personalEdgeGames: [4, 10] })).not.toContain(
      RISK_BADGE_THIN_SAMPLE,
    );
  });

  it("flags CohortOnly when extension has no personal edges", () => {
    expect(deriveRiskBadges({ ...clean, extensionHasPersonal: false })).toContain(
      RISK_BADGE_COHORT_ONLY,
    );
  });

  it("flags Narrow when onlyMoveCount ≥ 1", () => {
    expect(deriveRiskBadges({ ...clean, onlyMoveCount: 1 })).toContain(RISK_BADGE_NARROW);
  });

  it("flags HighVariance when evalSwingCp ≥ threshold", () => {
    expect(
      deriveRiskBadges({ ...clean, evalSwingCp: HIGH_VARIANCE_EVAL_SWING_MIN_CP }),
    ).toContain(RISK_BADGE_HIGH_VARIANCE);
    expect(
      deriveRiskBadges({ ...clean, evalSwingCp: HIGH_VARIANCE_EVAL_SWING_MIN_CP - 1 }),
    ).not.toContain(RISK_BADGE_HIGH_VARIANCE);
  });

  it("flags LowTheory when primary style is rare", () => {
    expect(deriveRiskBadges({ ...clean, primaryStyle: "rare" })).toContain(
      RISK_BADGE_LOW_THEORY,
    );
  });

  it("flags Transposes when entry transposes", () => {
    expect(deriveRiskBadges({ ...clean, entryTransposes: true })).toContain(
      RISK_BADGE_TRANSPOSITIONS,
    );
  });
});

describe("checkMemorabilityBudget", () => {
  it("passes a tree within all hard limits", () => {
    expect(checkMemorabilityBudget(validTree())).toEqual({
      ok: true,
      violations: [],
      warnings: [],
    });
  });

  it("violates when leafCount exceeds the cap", () => {
    const result = checkMemorabilityBudget(validTree({ leafCount: MEM_MAX_LEAVES + 1 }));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(`leafCount ${MEM_MAX_LEAVES + 1} exceeds ${MEM_MAX_LEAVES}`);
  });

  it("violates when forkCount exceeds the cap", () => {
    const result = checkMemorabilityBudget(validTree({ forkCount: MEM_MAX_FORKS + 1 }));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(`forkCount ${MEM_MAX_FORKS + 1} exceeds ${MEM_MAX_FORKS}`);
  });

  it("warns but does not violate when maxRepliesPerFork is 3", () => {
    const result = checkMemorabilityBudget(
      validTree({ maxRepliesPerFork: MEM_MAX_REPLIES_PER_FORK_WARN }),
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(String(MEM_MAX_REPLIES_PER_FORK_WARN));
  });

  it("violates when maxRepliesPerFork exceeds the rare allowance", () => {
    const over = MEM_MAX_REPLIES_PER_FORK_WARN + 1;
    const result = checkMemorabilityBudget(validTree({ maxRepliesPerFork: over }));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      `maxRepliesPerFork ${over} exceeds ${MEM_MAX_REPLIES_PER_FORK_WARN}`,
    );
  });

  it("violates only-move cap for non-forcing styles", () => {
    const over = MEM_MAX_ONLY_MOVE_NON_FORCING + 1;
    const result = checkMemorabilityBudget(
      validTree({ onlyMoveCount: over, style: "solid" }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("onlyMoveCount"))).toBe(true);
  });

  it("exempts forcing lines from the only-move cap", () => {
    const over = MEM_MAX_ONLY_MOVE_NON_FORCING + 1;
    const result = checkMemorabilityBudget(
      validTree({ onlyMoveCount: over, style: "forcing" }),
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("violates when concept family count exceeds the cap", () => {
    const families = [
      "pawnStructure",
      "development",
      "centerStrategy",
    ];
    expect(families.length).toBe(MEM_MAX_CONCEPT_FAMILIES + 1);
    const result = checkMemorabilityBudget(validTree({ conceptFamilies: families }));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      `conceptFamilies ${families.length} exceeds ${MEM_MAX_CONCEPT_FAMILIES}`,
    );
  });
});

describe("memPenalty", () => {
  it("matches the design §6 formula exactly", () => {
    const input = {
      forkCount: 3,
      uniqueConceptCount: 2,
      onlyMoveCount: 1,
      transpositionDivergence: 2,
    };
    const expected =
      MEM_PENALTY_FORK_COEF * Math.log2(1 + input.forkCount) +
      MEM_PENALTY_CONCEPT_COEF * input.uniqueConceptCount +
      MEM_PENALTY_ONLY_MOVE_COEF * input.onlyMoveCount +
      MEM_PENALTY_TRANSPOSITION_COEF * input.transpositionDivergence;
    expect(memPenalty(input)).toBe(expected);
    expect(memPenalty(input)).toBe(9);
  });
});

describe("conceptFamiliesForEdges", () => {
  it("maps multi-family features and ignores unknown ids", () => {
    expect(CONCEPT_FAMILY_BY_FEATURE.centralPawnPush).toEqual([
      CONCEPT_FAMILY_PAWN_STRUCTURE,
      CONCEPT_FAMILY_CENTER_STRATEGY,
    ]);

    const families = conceptFamiliesForEdges([
      ["centralPawnPush"],
      ["unknownFeature", "fianchetto"],
    ]);
    expect(families).toEqual([
      CONCEPT_FAMILY_CENTER_STRATEGY,
      "development",
      CONCEPT_FAMILY_PAWN_STRUCTURE,
    ]);
  });

  it("unions families across edges without duplicates", () => {
    const families = conceptFamiliesForEdges([
      ["quietPawnPush"],
      ["developsMinorFromHome"],
      ["isCastle"],
    ]);
    expect(families).toEqual(["castling", "development", "pawnStructure"]);
  });
});