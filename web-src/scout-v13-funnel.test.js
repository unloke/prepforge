import { describe, expect, it } from "vitest";

import { AUDIT_MIN_SUBJECT_CHOSE, epdFromUcis } from "./scout-route-audit.js";
import { V12_BANNED_VOCAB } from "./scout-v12-report.js";
import { EXT_ENDPOINT_MIN_CP } from "./scout-v13-extension.js";
import { MEM_MAX_LEAVES } from "./scout-v13-style.js";
import {
  MARGINAL_OVERLAP_COEF,
  PACKAGES_PER_COLOR,
  assertReportClean,
  runSelectionFunnel,
} from "./scout-v13-funnel.js";

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

/** Metrics that qualify as solid-only for bucket tests. */
function solidStyleMetrics(overrides = {}) {
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

function sharpStyleMetrics(overrides = {}) {
  return solidStyleMetrics({
    ourGaps: [18],
    evalSwingCp: 90,
    anchorAttribution: 0.9,
    attributionP75: 0.8,
    leakMoveIsCaptureOrCheck: true,
    ...overrides,
  });
}

function validMemTree(overrides = {}) {
  return {
    leafCount: 3,
    forkCount: 2,
    maxRepliesPerFork: 2,
    onlyMoveCount: 1,
    conceptFamilies: ["development"],
    transpositionDivergence: 0,
    ...overrides,
  };
}

function validRiskMetrics(overrides = {}) {
  return {
    personalEdgeGames: [10],
    extensionHasPersonal: false,
    onlyMoveCount: 0,
    evalSwingCp: 50,
    entryTransposes: false,
    ...overrides,
  };
}

/** Default extension mainline: our engine move, then his cohort reply (black subject). */
function defaultMainlineForAnchor(subjectColor, anchorLen = 2) {
  const ourFirst = isOurTurnAt(anchorLen, subjectColor);
  return ourFirst
    ? [engineEdge("g1f3"), cohortEdge("d7d6")]
    : [cohortEdge("d7d6"), engineEdge("g1f3")];
}

function isOurTurnAt(pathLen, subjectColor) {
  return subjectColor === "black" ? pathLen % 2 === 0 : pathLen % 2 === 1;
}

/**
 * @param {object} params
 */
function mkFunnelCandidate({
  id,
  subjectColor = "black",
  trunkUcis,
  entryEpd = null,
  entryUcis = null,
  tendencyIds = ["t0"],
  trunkSegments = [{ k: 10, n: 20 }],
  anchorAttribution = 5,
  trunkEdges = null,
  personalAnchorPly = null,
  reachLB = 0.5,
  extension = null,
  styleMetrics = solidStyleMetrics(),
  riskMetrics = validRiskMetrics(),
  memTree = validMemTree(),
  extensionMainlineUcis = null,
}) {
  const edges =
    trunkEdges ??
    trunkUcis.map((uci, i) => personalEdge(uci, 10 + i));
  const anchorPly = personalAnchorPly ?? trunkUcis.length;

  const defaultMainline = defaultMainlineForAnchor(subjectColor, trunkUcis.length);
  const ext = extension ?? {
    ok: true,
    mainline: defaultMainline,
    branches: [],
    leafCount: 1,
    endpointEvalCp: 20,
  };

  const mainUcis = ext.mainline.map((e) => e.uci);

  return {
    id,
    subjectColor,
    trunkUcis,
    trunkEndEpd: epdFromUcis(trunkUcis),
    entryEpd: entryEpd ?? epdFromUcis(trunkUcis),
    entryUcis: entryUcis ?? trunkUcis.filter((_, i) => i % 2 === 0),
    extensionMainlineUcis: extensionMainlineUcis ?? mainUcis,
    trunkSegments,
    anchorAttribution,
    tendencyIds,
    trunk: {
      edges,
      personalAnchorPly: anchorPly,
      reachLB,
    },
    extension: ext,
    styleMetrics,
    riskMetrics,
    memTree: {
      ...validMemTree(),
      leafCount: ext.leafCount,
      ...memTree,
    },
  };
}

/** Deterministic audit: eval from leaf path key or per-id overrides. */
function fakeAuditProvider(overrides = {}) {
  return {
    auditLeafEval: async (ucis) => {
      const key = ucis.join(",");
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        return { evalCp: overrides[key] };
      }
      return { evalCp: 10 };
    },
  };
}

describe("runSelectionFunnel — §11 step 4 acceptance", () => {
  it("兩 tendency 同 EPD 只出一包: merged tendencyIds + demotedNotes", async () => {
    const entry = epdFromUcis(["e2e4", "c7c5"]);
    const a = mkFunnelCandidate({
      id: "a",
      trunkUcis: ["e2e4", "c7c5"],
      entryEpd: entry,
      tendencyIds: ["sharpBias"],
      trunkSegments: [{ k: 10, n: 20 }],
      anchorAttribution: 5,
    });
    const b = mkFunnelCandidate({
      id: "b",
      trunkUcis: ["e2e4", "c7c5", "g1f3"],
      entryEpd: entry,
      tendencyIds: ["castleKingside"],
      trunkSegments: [{ k: 8, n: 20 }, { k: 6, n: 8 }],
      anchorAttribution: 4,
    });

    const report = await runSelectionFunnel([a, b], fakeAuditProvider());
    expect(report.packages).toHaveLength(1);
    expect(report.packages[0].tendencyIds).toEqual(
      expect.arrayContaining(["sharpBias", "castleKingside"]),
    );
    expect(report.packages[0].demotedNotes.length).toBeGreaterThan(0);
    expect(report.packages[0].demotedNotes[0]).toContain("此計畫亦由傾向");
    expect(report.eliminated).toHaveLength(0);
  });

  it("個人 ply 7 斷 → 延伸到 14 且收據分離", async () => {
    const trunkUcis = [
      "e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4",
    ];
    const extensionMainline = [
      cohortEdge("b8c6"),
      engineEdge("c1e3"),
      cohortEdge("g8f6"),
      engineEdge("f1e2"),
      cohortEdge("e7e5"),
      engineEdge("e1g1"),
      cohortEdge("f8e7"),
    ];

    const candidate = mkFunnelCandidate({
      id: "ply7",
      trunkUcis,
      personalAnchorPly: 7,
      trunkEdges: trunkUcis.map((uci) => personalEdge(uci, 12)),
      extension: {
        ok: true,
        mainline: extensionMainline,
        branches: [],
        leafCount: 1,
        endpointEvalCp: 15,
      },
      memTree: validMemTree({ leafCount: 1, forkCount: 0 }),
    });

    const report = await runSelectionFunnel([candidate], fakeAuditProvider());
    expect(report.packages).toHaveLength(1);
    const pkg = report.packages[0];

    expect(pkg.trunk.personalAnchorPly).toBe(7);
    expect(pkg.trunk.edges.every((e) => e.evidenceSource === "personal")).toBe(true);
    expect(
      pkg.extension.mainline
        .filter((e) => e.evidenceSource === "cohort")
        .every((e) => e.receipts.ratingBand),
    ).toBe(true);

    const trunkGames = pkg.trunk.edges.map((e) => e.receipts.games);
    const cohortGames = pkg.extension.mainline
      .filter((e) => e.evidenceSource === "cohort")
      .map((e) => e.receipts.explorerGames);
    expect(trunkGames.every((g) => g >= AUDIT_MIN_SUBJECT_CHOSE)).toBe(true);
    expect(cohortGames.length).toBeGreaterThan(0);

    expect(pkg.trunk.reachLB).toBeDefined();
    expect(pkg).not.toHaveProperty("combinedReach");
    expect(pkg).not.toHaveProperty("cohortReachLB");
    const trunkReceiptGames = pkg.trunk.edges.map((e) => e.receipts.games);
    const cohortReceiptGames = pkg.extension.mainline
      .filter((e) => e.evidenceSource === "cohort")
      .map((e) => e.receipts.explorerGames);
    expect(trunkReceiptGames).not.toEqual(cohortReceiptGames);
  });

  it("空桶誠實: solid-only survivors → sharp/rare/forcing vacancies, ≤4 packages", async () => {
    const trunkVariants = [
      ["e2e4", "c7c5", "g1f3"],
      ["e2e4", "c7c5", "b1c3"],
      ["e2e4", "c7c5", "f2f4"],
      ["e2e4", "e7e5", "g1f3"],
      ["d2d4", "d7d5", "c2c4"],
    ];
    const candidates = trunkVariants.map((trunkUcis, i) =>
      mkFunnelCandidate({
        id: `p${i + 1}`,
        trunkUcis,
        entryEpd: epdFromUcis(trunkUcis),
        tendencyIds: [`p${i + 1}`],
        trunkSegments: [{ k: 10 - i, n: 20 }],
        anchorAttribution: 10 - i,
        memTree: validMemTree({
          conceptFamilies: [`family${i}`],
        }),
      }),
    );

    const report = await runSelectionFunnel(candidates, fakeAuditProvider());
    expect(report.packages.length).toBeLessThanOrEqual(PACKAGES_PER_COLOR);
    expect(report.packages.every((p) => p.primaryStyle === "solid")).toBe(true);

    const vacantBuckets = report.bucketVacancies
      .filter((v) => v.color === "black")
      .map((v) => v.bucket);
    expect(vacantBuckets).toEqual(
      expect.arrayContaining(["sharp", "rare", "forcing"]),
    );
    expect(report.packages.length).toBeGreaterThan(0);
    expect(report.packages.length).toBeLessThanOrEqual(4);
  });

  it("全報告無禁詞無 π", async () => {
    const candidate = mkFunnelCandidate({
      id: "clean",
      trunkUcis: ["e2e4", "c7c5"],
    });
    const report = await runSelectionFunnel([candidate], fakeAuditProvider());
    const json = JSON.stringify(report);

    expect(json).not.toContain("piTilt");
    for (const word of V12_BANNED_VOCAB) {
      expect(json).not.toContain(word);
    }
    expect(() => assertReportClean(report)).not.toThrow();
  });
});

describe("runSelectionFunnel — stage 1 hard gates", () => {
  it("eliminates extension.ok=false with extension:<reason>", async () => {
    const bad = mkFunnelCandidate({
      id: "bad-ext",
      trunkUcis: ["e2e4", "c7c5"],
      extension: {
        ok: false,
        reason: "soundnessFail",
        mainline: [],
        branches: [],
        leafCount: 0,
        endpointEvalCp: null,
      },
    });

    const report = await runSelectionFunnel([bad], fakeAuditProvider());
    expect(report.packages).toHaveLength(0);
    expect(report.eliminated).toEqual([
      { id: "bad-ext", reasons: ["extension:soundnessFail"] },
    ]);
  });

  it("eliminates all-engine his-side extension with factuality:cohort", async () => {
    const bad = mkFunnelCandidate({
      id: "engine-his",
      trunkUcis: ["e2e4", "c7c5"],
      subjectColor: "black",
      extension: {
        ok: true,
        mainline: [engineEdge("g1f3"), engineEdge("d7d6")],
        branches: [],
        leafCount: 1,
        endpointEvalCp: 10,
      },
      memTree: validMemTree({ leafCount: 1, forkCount: 0 }),
    });

    const report = await runSelectionFunnel([bad], fakeAuditProvider());
    expect(report.packages).toHaveLength(0);
    expect(report.eliminated[0].reasons).toContain("factuality:cohort");
  });

  it("eliminates trunk without a ≥5-games personal edge", async () => {
    const bad = mkFunnelCandidate({
      id: "thin-trunk",
      trunkUcis: ["e2e4", "c7c5"],
      trunkEdges: [
        personalEdge("e2e4", AUDIT_MIN_SUBJECT_CHOSE - 1),
        personalEdge("c7c5", AUDIT_MIN_SUBJECT_CHOSE - 1),
      ],
    });

    const report = await runSelectionFunnel([bad], fakeAuditProvider());
    expect(report.packages).toHaveLength(0);
    expect(report.eliminated[0].reasons).toContain("factuality:trunkPersonal");
  });
});

describe("runSelectionFunnel — memorability pruning (stage 1)", () => {
  it("prunes last branch when budget violated with 2 branches, then survives", async () => {
    const branchA = {
      forkPlyIndex: 0,
      edges: [engineEdge("b1c3"), cohortEdge("b8c6")],
    };
    const branchB = {
      forkPlyIndex: 0,
      edges: [engineEdge("f2f4"), cohortEdge("e7e6")],
    };

    const candidate = mkFunnelCandidate({
      id: "mem-prune",
      trunkUcis: ["e2e4", "c7c5"],
      extension: {
        ok: true,
        mainline: defaultMainlineForAnchor("black", 2),
        branches: [branchA, branchB],
        leafCount: MEM_MAX_LEAVES + 1,
        endpointEvalCp: 15,
      },
      memTree: validMemTree({
        leafCount: MEM_MAX_LEAVES + 1,
        forkCount: 2,
      }),
    });

    const report = await runSelectionFunnel([candidate], fakeAuditProvider());
    expect(report.packages).toHaveLength(1);
    expect(report.packages[0].extension.branches).toHaveLength(1);
    expect(report.packages[0].extension.leafCount).toBe(MEM_MAX_LEAVES);
    expect(report.eliminated).toHaveLength(0);
  });

  it("eliminates when budget still violated with zero branches", async () => {
    const candidate = mkFunnelCandidate({
      id: "mem-fail",
      trunkUcis: ["e2e4", "c7c5"],
      extension: {
        ok: true,
        mainline: defaultMainlineForAnchor("black", 2),
        branches: [],
        leafCount: MEM_MAX_LEAVES + 1,
        endpointEvalCp: 15,
      },
      memTree: validMemTree({
        leafCount: MEM_MAX_LEAVES + 1,
        forkCount: 0,
        onlyMoveCount: 5,
      }),
    });

    const report = await runSelectionFunnel([candidate], fakeAuditProvider());
    expect(report.packages).toHaveLength(0);
    expect(report.eliminated[0].reasons.some((r) => r.startsWith("memorability:"))).toBe(
      true,
    );
  });
});

describe("runSelectionFunnel — stage 5 full-package audit", () => {
  it("prunes failing branch leaf (−40), records prunedBranches, package survives", async () => {
    const badBranch = {
      forkPlyIndex: 0,
      edges: [engineEdge("f2f4"), cohortEdge("e7e6")],
    };
    const goodBranch = {
      forkPlyIndex: 0,
      edges: [engineEdge("b1c3"), cohortEdge("b8c6")],
    };

    const trunkUcis = ["e2e4", "c7c5"];
    const mainline = defaultMainlineForAnchor("black", trunkUcis.length);
    const badLeafUcis = [
      ...trunkUcis,
      ...badBranch.edges.map((e) => e.uci),
    ].join(",");

    const candidate = mkFunnelCandidate({
      id: "branch-audit",
      trunkUcis,
      extension: {
        ok: true,
        mainline,
        branches: [goodBranch, badBranch],
        leafCount: 3,
        endpointEvalCp: 10,
      },
      memTree: validMemTree({ leafCount: 3, forkCount: 2 }),
    });

    const report = await runSelectionFunnel(
      [candidate],
      fakeAuditProvider({ [badLeafUcis]: -40 }),
    );

    expect(report.packages).toHaveLength(1);
    expect(report.eliminated).toHaveLength(0);
    expect(report.prunedBranches).toEqual([
      { packageId: "branch-audit", forkPlyIndex: badBranch.forkPlyIndex },
    ]);
    expect(report.packages[0].extension.branches).toHaveLength(1);
  });

  it("eliminates mainline leaf failure and backfills next candidate", async () => {
    const trunkMain = ["e2e4", "c7c5"];
    const mainlineMain = defaultMainlineForAnchor("black", trunkMain.length);
    const mainLeafKey = [...trunkMain, ...mainlineMain.map((e) => e.uci)].join(",");

    const failing = mkFunnelCandidate({
      id: "main-fail",
      trunkUcis: trunkMain,
      trunkSegments: [{ k: 15, n: 20 }],
      anchorAttribution: 10,
      styleMetrics: solidStyleMetrics(),
    });

    const backfill = mkFunnelCandidate({
      id: "backfill",
      trunkUcis: ["e2e4", "e7e6"],
      entryEpd: epdFromUcis(["e2e4", "e7e6"]),
      trunkSegments: [{ k: 8, n: 20 }],
      anchorAttribution: 5,
      memTree: validMemTree({ conceptFamilies: ["centerStrategy"] }),
    });

    const report = await runSelectionFunnel(
      [failing, backfill],
      fakeAuditProvider({ [mainLeafKey]: -40 }),
    );

    expect(report.eliminated).toEqual([
      { id: "main-fail", reasons: ["audit:mainlineLeaf"] },
    ]);
    expect(report.packages).toHaveLength(1);
    expect(report.packages[0].id).toBe("backfill");
  });
});

describe("runSelectionFunnel — bucket collision + backfill", () => {
  it("two sharp representatives: higher personalScore wins bucket, loser backfills", async () => {
    const sharpMetrics = sharpStyleMetrics();

    const winner = mkFunnelCandidate({
      id: "sharp-high",
      trunkUcis: ["e2e4", "c7c5"],
      trunkSegments: [{ k: 15, n: 20 }],
      anchorAttribution: 10,
      styleMetrics: sharpMetrics,
      memTree: validMemTree({ conceptFamilies: ["pawnStructure"] }),
    });

    const loser = mkFunnelCandidate({
      id: "sharp-low",
      trunkUcis: ["e2e4", "e7e5"],
      entryEpd: epdFromUcis(["e2e4", "e7e5"]),
      trunkSegments: [{ k: 8, n: 20 }],
      anchorAttribution: 5,
      styleMetrics: sharpMetrics,
      memTree: validMemTree({ conceptFamilies: ["development"] }),
    });

    const solid = mkFunnelCandidate({
      id: "solid-extra",
      trunkUcis: ["d2d4", "d7d5"],
      entryEpd: epdFromUcis(["d2d4", "d7d5"]),
      trunkSegments: [{ k: 12, n: 20 }],
      anchorAttribution: 8,
      styleMetrics: solidStyleMetrics(),
      memTree: validMemTree({ conceptFamilies: ["castling"] }),
    });

    const report = await runSelectionFunnel(
      [winner, loser, solid],
      fakeAuditProvider(),
    );

    const ids = report.packages.map((p) => p.id);
    expect(ids).toContain("sharp-high");
    expect(ids).toContain("sharp-low");
    expect(ids).toContain("solid-extra");
    expect(report.packages.filter((p) => p.primaryStyle === "sharp")).toHaveLength(2);
    const sharpWinner = report.packages.find((p) => p.id === "sharp-high");
    const sharpLoser = report.packages.find((p) => p.id === "sharp-low");
    expect(sharpWinner).toBeDefined();
    expect(sharpLoser).toBeDefined();
    expect(report.packages.length).toBe(3);
  });
});

describe("runSelectionFunnel — exported constants", () => {
  it("exports harness-calibratable constants", () => {
    expect(PACKAGES_PER_COLOR).toBe(4);
    expect(MARGINAL_OVERLAP_COEF).toBeGreaterThan(0);
    expect(EXT_ENDPOINT_MIN_CP).toBe(-20);
  });
});