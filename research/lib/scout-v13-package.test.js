import { describe, expect, it } from "vitest";

import { jeffreysLower } from "./scout-bias-routes.js";
import { AUDIT_MIN_SUBJECT_CHOSE, epdFromUcis } from "./scout-route-audit.js";
import {
  candidatePersonalScore,
  coverageComponents,
  personalReachFromSegments,
  selectComponentRepresentative,
  validateEvidenceEdge,
  validatePrepPackage,
} from "./scout-v13-package.js";

function personalEdge(uci, games, extra = {}) {
  return {
    uci,
    evidenceSource: "personal",
    receipts: { games, wins: games - 1, draws: 0, losses: 1 },
    ...extra,
  };
}

function cohortEdge(uci, extra = {}) {
  return {
    uci,
    evidenceSource: "cohort",
    receipts: {
      explorerGames: 500,
      sharePct: 34,
      ratingBand: "1800-2000",
      speed: "blitz",
    },
    ...extra,
  };
}

function engineEdge(uci, evalCp = 20) {
  return {
    uci,
    evidenceSource: "engine",
    receipts: { evalCp },
  };
}

function validPackage(overrides = {}) {
  return {
    entryRegion: {
      epd: epdFromUcis(["e2e4", "c7c5"]),
      ourEntryUcis: ["e2e4"],
    },
    trunk: {
      edges: [personalEdge("e2e4", 80), personalEdge("c7c5", 80)],
      personalAnchorPly: 4,
      reachLB: 0.6,
    },
    extension: {
      mainline: [cohortEdge("g1f3"), engineEdge("d7d6")],
      branches: [[cohortEdge("b8c6")]],
    },
    style: "solid",
    tendencyIds: ["developsMinorFromHome"],
    tier: null,
    riskTags: [],
    receipts: {},
    notes: [],
    ...overrides,
  };
}

function mkCandidate({
  id,
  trunkUcis,
  extensionMainlineUcis = [],
  entryUcis = null,
  entryEpd = null,
  tendencyIds = ["t0"],
  trunkSegments = [{ k: 5, n: 10 }],
  anchorAttribution = 1,
  subjectColor = "black",
}) {
  const entry = entryEpd ?? epdFromUcis(trunkUcis);
  return {
    id,
    trunkUcis,
    trunkEndEpd: epdFromUcis(trunkUcis),
    entryEpd: entry,
    entryUcis: entryUcis ?? trunkUcis.filter((_, i) => i % 2 === 0),
    extensionMainlineUcis,
    subjectColor,
    trunkSegments,
    anchorAttribution,
    tendencyIds,
  };
}

describe("coverageComponents + selectComponentRepresentative", () => {
  it("synthetic trie parent 80 / grandchild 20 → one component, grandchild wins when scored higher", () => {
    const parentTrunk = ["e2e4", "c7c5"];
    const grandchildTrunk = ["e2e4", "c7c5", "g1f3", "d7d6"];
    const parent = mkCandidate({
      id: "parent",
      trunkUcis: parentTrunk,
      trunkSegments: [{ k: 80, n: 80 }],
      anchorAttribution: 1,
    });
    const grandchild = mkCandidate({
      id: "grandchild",
      trunkUcis: grandchildTrunk,
      trunkSegments: [
        { k: 20, n: 80 },
        { k: 18, n: 20 },
      ],
      anchorAttribution: 50,
    });

    const components = coverageComponents([parent, grandchild]);
    expect(components).toHaveLength(1);
    expect(components[0]).toHaveLength(2);

    const { representative, demoted } = selectComponentRepresentative(components[0]);
    expect(representative.id).toBe("grandchild");
    expect(demoted).toHaveLength(1);
    expect(demoted[0].candidate.id).toBe("parent");
    expect(candidatePersonalScore(grandchild)).toBeGreaterThan(candidatePersonalScore(parent));
  });

  it("two tendencies, same entry EPD → one component with merged tendencyIds", () => {
    const entry = epdFromUcis(["e2e4", "c7c5"]);
    const a = mkCandidate({
      id: "a",
      trunkUcis: ["e2e4", "c7c5"],
      entryEpd: entry,
      tendencyIds: ["sharpBias"],
      trunkSegments: [{ k: 10, n: 20 }],
      anchorAttribution: 5,
    });
    const b = mkCandidate({
      id: "b",
      trunkUcis: ["e2e4", "c7c5", "g1f3"],
      entryEpd: entry,
      tendencyIds: ["castleKingside"],
      trunkSegments: [{ k: 8, n: 20 }, { k: 6, n: 8 }],
      anchorAttribution: 4,
    });

    const components = coverageComponents([a, b]);
    expect(components).toHaveLength(1);

    const { representative, demoted } = selectComponentRepresentative(components[0]);
    expect(representative.tendencyIds).toEqual(
      expect.arrayContaining(["sharpBias", "castleKingside"]),
    );
    expect(demoted).toHaveLength(1);
    const demotedTendency = demoted[0].candidate.tendencyIds[0];
    expect(demoted[0].note).toContain("此計畫亦由傾向");
    expect(demoted[0].note).toContain(demotedTendency);
  });

  it("transposition (different move orders, same entryEpd) → one component", () => {
    const entry = epdFromUcis(["d2d4", "d7d5", "c2c4", "e7e6", "b1c3"]);
    const orderA = mkCandidate({
      id: "a",
      trunkUcis: ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3"],
      entryEpd: entry,
      entryUcis: ["d2d4", "c2c4", "b1c3"],
    });
    const orderB = mkCandidate({
      id: "b",
      trunkUcis: ["d2d4", "d7d5", "g1f3", "g8f6", "c2c4"],
      entryEpd: entry,
      entryUcis: ["d2d4", "g1f3", "c2c4"],
    });

    const components = coverageComponents([orderA, orderB]);
    expect(components).toHaveLength(1);
  });

  it("unrelated candidates → separate components, input order preserved within each", () => {
    const sicilian = mkCandidate({
      id: "sicilian",
      trunkUcis: ["e2e4", "c7c5"],
      entryEpd: epdFromUcis(["e2e4", "c7c5"]),
    });
    const french = mkCandidate({
      id: "french",
      trunkUcis: ["e2e4", "e7e6"],
      entryEpd: epdFromUcis(["e2e4", "e7e6"]),
    });
    const caro = mkCandidate({
      id: "caro",
      trunkUcis: ["e2e4", "c7c6"],
      entryEpd: epdFromUcis(["e2e4", "c7c6"]),
    });

    const components = coverageComponents([sicilian, french, caro]);
    expect(components).toHaveLength(3);
    expect(components.map((c) => c.map((x) => x.id))).toEqual([
      ["sicilian"],
      ["french"],
      ["caro"],
    ]);
  });

  it("shared first-4-half-move extension plan → same component", () => {
    const sharedPlan = ["g1f3", "b8c6", "f1b5", "a7a6"];
    const a = mkCandidate({
      id: "a",
      trunkUcis: ["e2e4", "e7e5"],
      extensionMainlineUcis: sharedPlan,
      entryEpd: epdFromUcis(["e2e4", "e7e5"]),
    });
    const b = mkCandidate({
      id: "b",
      trunkUcis: ["d2d4", "d7d5", "c2c4", "e7e6"],
      extensionMainlineUcis: sharedPlan,
      entryEpd: epdFromUcis(["d2d4", "d7d5", "c2c4", "e7e6"]),
    });

    const components = coverageComponents([a, b]);
    expect(components).toHaveLength(1);
  });

  it("group-first regression: shallow parent first but deeper candidate wins on score", () => {
    const shallow = mkCandidate({
      id: "shallow",
      trunkUcis: ["e2e4", "c7c5"],
      trunkSegments: [{ k: 60, n: 60 }],
      anchorAttribution: 2,
    });
    const deep = mkCandidate({
      id: "deep",
      trunkUcis: ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4"],
      trunkSegments: [
        { k: 30, n: 60 },
        { k: 25, n: 30 },
        { k: 20, n: 25 },
      ],
      anchorAttribution: 40,
    });
    const other = mkCandidate({
      id: "other",
      trunkUcis: ["e2e4", "c7c5", "g1f3"],
      trunkSegments: [{ k: 10, n: 60 }, { k: 5, n: 10 }],
      anchorAttribution: 1,
    });

    const component = [shallow, deep, other];
    const { representative } = selectComponentRepresentative(component);
    expect(representative.id).toBe("deep");
    expect(candidatePersonalScore(deep)).toBeGreaterThan(candidatePersonalScore(shallow));
    expect(candidatePersonalScore(deep)).toBeGreaterThan(candidatePersonalScore(other));
  });
});

describe("personalReachFromSegments", () => {
  it("multiplies Jeffreys LB over trunk segments only", () => {
    const reach = personalReachFromSegments([
      { k: 5, n: 5 },
      { k: 9, n: 12 },
    ]);
    expect(reach).toBeCloseTo(jeffreysLower(5, 5) * jeffreysLower(9, 12), 8);
  });
});

describe("validateEvidenceEdge", () => {
  it("rejects missing evidenceSource", () => {
    const result = validateEvidenceEdge({
      uci: "e2e4",
      receipts: { games: 10, wins: 6, draws: 2, losses: 2 },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("evidenceSource"))).toBe(true);
  });

  it("rejects 他會 in a cohort edge note", () => {
    const result = validateEvidenceEdge(
      cohortEdge("g1f3", { note: "他會常下 Nf3" }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("他會"))).toBe(true);
  });
});

describe("validatePrepPackage", () => {
  it("rejects extension personal edge with games < AUDIT_MIN_SUBJECT_CHOSE", () => {
    const pkg = validPackage({
      extension: {
        mainline: [personalEdge("g1f3", AUDIT_MIN_SUBJECT_CHOSE - 1)],
        branches: [],
      },
    });
    const result = validatePrepPackage(pkg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(`>= ${AUDIT_MIN_SUBJECT_CHOSE}`))).toBe(true);
  });

  it("rejects missing personalAnchorPly", () => {
    const pkg = validPackage({
      trunk: {
        edges: [personalEdge("e2e4", 80)],
        reachLB: 0.5,
      },
    });
    const result = validatePrepPackage(pkg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("personalAnchorPly"))).toBe(true);
  });

  it("accepts a fully valid package", () => {
    const result = validatePrepPackage(validPackage());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects trunk edges that are not personal", () => {
    const pkg = validPackage({
      trunk: {
        edges: [cohortEdge("e2e4")],
        personalAnchorPly: 2,
        reachLB: 0.5,
      },
    });
    const result = validatePrepPackage(pkg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("trunk edges must be personal"))).toBe(true);
  });

  it("allows extension personal edge when games >= AUDIT_MIN_SUBJECT_CHOSE", () => {
    const pkg = validPackage({
      extension: {
        mainline: [personalEdge("g1f3", AUDIT_MIN_SUBJECT_CHOSE)],
        branches: [],
      },
    });
    const result = validatePrepPackage(pkg);
    expect(result.ok).toBe(true);
  });
});