import { describe, expect, it } from "vitest";

import { Chess } from "chess.js";

import { validateEvidenceEdge, validatePrepPackage } from "./scout-v13-package.js";
import { buildExtension } from "./scout-v13-extension.js";
import { runSelectionFunnel } from "./scout-v13-funnel.js";
import { AUDIT_MIN_SUBJECT_CHOSE } from "./scout-route-audit.js";
import {
  assembleFunnelCandidate,
  bindSegmentGames,
  buildTrunkEdges,
  countPathSegments,
  cutTrunkAtPersonalAnchor,
  deriveMemTree,
  deriveStyleMetrics,
  detectSacrifice,
  entryEpdFromPath,
  entryUcisFromPath,
  jeffreysLower,
  makePersonalRepliesProvider,
  reachLBFromSegments,
} from "./scout-v13-adapter.js";

function mkGame(ucis, color, score = 1) {
  return { ucis, openingUcis: ucis, color, score };
}

function personalEdge(uci, games) {
  return {
    uci,
    evidenceSource: "personal",
    receipts: { games, wins: games - 1, draws: 0, losses: 1 },
  };
}

function cohortEdge(uci) {
  return {
    uci,
    evidenceSource: "cohort",
    receipts: {
      explorerGames: 500,
      sharePct: 34,
      ratingBand: "1800-2000",
      speed: "blitz",
    },
  };
}

function engineEdge(uci, evalCp = 25) {
  return {
    uci,
    evidenceSource: "engine",
    receipts: { evalCp, gapToBestCp: 5 },
  };
}

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

describe("countPathSegments", () => {
  const path = ["e2e4", "c7c5", "g1f3", "d7d6"];

  const games = [
    ...Array.from({ length: 6 }, () => mkGame(path, "black")),
    mkGame(["e2e4", "c7c5", "g1f3", "g8f6"], "black"),
    mkGame(["e2e4", "c7c5", "b1c3", "d7d6"], "black"),
    mkGame(["e2e4", "e7e5"], "black"),
    mkGame(path, "white"),
  ];

  it("counts n/k at each his ply for black subject", () => {
    const segs = countPathSegments(games, path, "black");
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ plyIndex: 1, n: 9, k: 8 });
    expect(segs[1]).toMatchObject({ plyIndex: 3, n: 7, k: 6 });
  });

  it("mirrors for white subject on reversed color games", () => {
    const whitePath = ["e2e4", "e7e5", "g1f3", "b8c6"];
    const whiteGames = [
      ...Array.from({ length: 5 }, () => mkGame(whitePath, "white")),
      mkGame(["e2e4", "e7e5", "g1f3", "d7d6"], "white"),
      mkGame(["d2d4", "d7d5"], "white"),
      mkGame(whitePath, "black"),
    ];
    const segs = countPathSegments(whiteGames, whitePath, "white");
    expect(segs[0]).toMatchObject({ plyIndex: 0, n: 7, k: 6 });
    expect(segs[1]).toMatchObject({ plyIndex: 2, n: 6, k: 6 });
  });
});

describe("cutTrunkAtPersonalAnchor", () => {
  const path = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6"];

  it("keeps trunk while k >= AUDIT_MIN_SUBJECT_CHOSE", () => {
    const segments = [
      { plyIndex: 1, n: 10, k: 8, wins: 6, draws: 1, losses: 1 },
      { plyIndex: 3, n: 8, k: 6, wins: 4, draws: 1, losses: 1 },
      { plyIndex: 5, n: 6, k: 5, wins: 3, draws: 1, losses: 1 },
      { plyIndex: 7, n: 5, k: 4, wins: 2, draws: 1, losses: 1 },
    ];
    const { trunkUcis, personalAnchorPly } = cutTrunkAtPersonalAnchor(
      { ucis: path, subjectColor: "black" },
      segments,
    );
    expect(trunkUcis).toEqual(["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"]);
    expect(personalAnchorPly).toBe(6);
  });

  it("cuts at boundary k=4 and ends on his move", () => {
    const segments = [
      { plyIndex: 1, n: 10, k: AUDIT_MIN_SUBJECT_CHOSE, wins: 3, draws: 1, losses: 1 },
      { plyIndex: 3, n: 8, k: AUDIT_MIN_SUBJECT_CHOSE - 1, wins: 2, draws: 1, losses: 1 },
    ];
    const { trunkUcis, personalAnchorPly } = cutTrunkAtPersonalAnchor(
      { ucis: path.slice(0, 4), subjectColor: "black" },
      segments,
    );
    expect(trunkUcis).toEqual(["e2e4", "c7c5"]);
    expect(personalAnchorPly).toBe(2);
  });

  it("returns empty trunk when first his edge fails", () => {
    const segments = [
      { plyIndex: 1, n: 10, k: AUDIT_MIN_SUBJECT_CHOSE - 1, wins: 2, draws: 1, losses: 1 },
    ];
    const out = cutTrunkAtPersonalAnchor(
      { ucis: path, subjectColor: "black" },
      segments,
    );
    expect(out).toEqual({ trunkUcis: [], personalAnchorPly: 0 });
  });
});

describe("buildTrunkEdges", () => {
  const trunkUcis = ["e2e4", "c7c5", "g1f3", "d7d6"];
  const segments = bindSegmentGames(
    [
      { plyIndex: 1, n: 10, k: 8, wins: 5, draws: 2, losses: 1 },
      { plyIndex: 3, n: 8, k: 6, wins: 4, draws: 1, losses: 1 },
    ],
    [],
  );

  it("passes edge validator and trunk-only-personal rule", () => {
    const built = buildTrunkEdges(trunkUcis, segments, "black");
    expect(built.edges.every((e) => e.evidenceSource === "personal")).toBe(true);
    for (const edge of built.edges) {
      const result = validateEvidenceEdge(edge);
      expect(result.ok, result.errors.join("; ")).toBe(true);
    }
    expect(built.trunkSegments).toEqual([
      { k: 8, n: 10 },
      { k: 6, n: 8 },
    ]);
  });

  it("reachLB matches hand-computed Jeffreys product", () => {
    const built = buildTrunkEdges(trunkUcis, segments, "black");
    const expected =
      jeffreysLower(8, 10) * jeffreysLower(6, 8);
    expect(built.reachLB).toBeCloseTo(expected, 10);
    expect(reachLBFromSegments(built.trunkSegments)).toBeCloseTo(expected, 10);
  });
});

describe("makePersonalRepliesProvider", () => {
  const games = [
    mkGame(["e2e4", "c7c5", "g1f3", "d7d6", "d2d4"], "black"),
    mkGame(["e2e4", "c7c5", "g1f3", "d7d6", "b1c3"], "black"),
    mkGame(["e2e4", "c7c5", "g1f3", "d7d6", "d2d4"], "black"),
    mkGame(["e2e4", "c7c5", "g1f3", "g8f6"], "black"),
  ];

  it("counts replies at his-to-move prefix", async () => {
    const provider = makePersonalRepliesProvider(games, "black");
    const replies = await provider(["e2e4", "c7c5", "g1f3"]);
    const byUci = Object.fromEntries(replies.map((r) => [r.uci, r.games]));
    expect(byUci.d7d6).toBe(3);
    expect(byUci.g8f6).toBe(1);
  });

  it("returns empty for non-matching prefix", async () => {
    const provider = makePersonalRepliesProvider(games, "black");
    const replies = await provider(["e2e4", "e7e5"]);
    expect(replies).toEqual([]);
  });
});

describe("deriveStyleMetrics", () => {
  it("computes share%, coverage%, density, swing from hand-built inputs", () => {
    const metrics = deriveStyleMetrics({
      endpointEvalCp: 22,
      ourGaps: [12, 8],
      anchorReplyEvals: [30, 10, 25],
      mainlineUcis: ["e2e4", "c7c5"],
      ourColor: "white",
      anchorAttribution: 0.9,
      attributionP75: 0.7,
      ourMultipvGaps: [120, 40],
      entryMoveExplorerSharePct: 4,
      entryNodeTotalGames: 12000,
      keyNodeReplySets: [
        { replyEvals: [40, 35, 10] },
        { replyEvals: [15, 12, 14] },
      ],
      keyNodeHisReplies: [
        {
          fen: new Chess("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1").fen(),
          ucis: ["e7e5", "e7e6"],
        },
        {
          fen: new Chess("rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2").fen(),
          ucis: ["d4e5", "g1f3"],
        },
      ],
      keyNodeExplorer: [
        { totalGames: 1000, moves: [{ games: 400 }, { games: 300 }] },
        { totalGames: 500, moves: [{ games: 200 }, { games: 150 }] },
      ],
    });

    expect(metrics.evalSwingCp).toBe(20);
    expect(metrics.onlyMoveCount).toBe(1);
    expect(metrics.entryMoveExplorerSharePct).toBe(4);
    expect(metrics.goodRepliesWithin50Cp).toBe(3);
    expect(metrics.checkCaptureThreatDensity).toBeGreaterThan(0);
    expect(metrics.topTwoRepliesCoveragePct).toBe(70);
    expect(metrics.hasSacrifice).toBe(false);
  });

  it("detects sacrifice when material does not recover within 2 plies", () => {
    const sacLine = ["e2e4", "e7e5", "d2d4", "e5d4"];
    expect(detectSacrifice(sacLine, "white")).toBe(true);
    expect(
      deriveStyleMetrics({
        endpointEvalCp: 0,
        ourGaps: [],
        anchorReplyEvals: [],
        mainlineUcis: sacLine,
        ourColor: "white",
        anchorAttribution: 0,
        attributionP75: 0,
        ourMultipvGaps: [],
        entryMoveExplorerSharePct: 50,
        entryNodeTotalGames: 100,
        keyNodeReplySets: [],
        keyNodeHisReplies: [],
        keyNodeExplorer: [],
      }).hasSacrifice,
    ).toBe(true);
  });

  it("false when sac is recaptured within 2 plies", () => {
    const recaptureLine = ["e2e4", "e7e5", "d2d4", "e5d4", "d1d4"];
    expect(detectSacrifice(recaptureLine, "white")).toBe(false);
  });
});

describe("deriveMemTree", () => {
  it("groups forks and maps concept families from stub featureVector", () => {
    const extensionResult = {
      ok: true,
      mainline: [engineEdge("g1f3"), cohortEdge("d7d6")],
      branches: [
        { forkPlyIndex: 0, edges: [cohortEdge("g8f6")] },
        { forkPlyIndex: 0, edges: [engineEdge("b8c6")] },
        { forkPlyIndex: 2, edges: [cohortEdge("e7e5")] },
      ],
      leafCount: 4,
      endpointEvalCp: 20,
    };

    const stubFv = () => {
      const vec = new Float64Array(40);
      vec[25] = 1;
      return vec;
    };

    const mem = deriveMemTree(
      extensionResult,
      [{ uci: "g1f3", fen: new Chess().fen(), prevOwnMoveUci: null }],
      {
        onlyMoveCount: 1,
        featureVectorFn: stubFv,
        buildDecisionContextFn: (fen) => ({ fen }),
      },
    );

    expect(mem.leafCount).toBe(4);
    expect(mem.forkCount).toBe(2);
    expect(mem.maxRepliesPerFork).toBe(2);
    expect(mem.onlyMoveCount).toBe(1);
    expect(mem.conceptFamilies).toContain("development");
  });
});

describe("assembleFunnelCandidate + funnel integration", () => {
  function makeProviders() {
    return {
      sfTopMoves: async (ucis) => {
        if (ucis.length % 2 === 0) {
          return [{ uci: "g1f3", evalCpOur: 25, gapToBestCp: 5 }];
        }
        return [{ uci: "d7d6", evalCpOur: 20, gapToBestCp: 0 }];
      },
      explorerReplies: async () => ({
        totalGames: 1000,
        ratingBand: "1800-2000",
        speed: "blitz",
        moves: [{ uci: "d7d6", games: 400, sharePct: 40 }],
      }),
      personalReplies: async () => [
        { uci: "d7d6", games: 10, wins: 7, draws: 1, losses: 2 },
      ],
    };
  }

  it("end-to-end fakes feed runSelectionFunnel and validatePrepPackage", async () => {
    const trunkUcis = ["e2e4", "c7c5"];
    const segments = bindSegmentGames(
      [{ plyIndex: 1, n: 20, k: 10, wins: 7, draws: 1, losses: 2 }],
      [],
    );
    const trunk = buildTrunkEdges(trunkUcis, segments, "black");
    const extension = await buildExtension(
      { anchorUcis: trunkUcis, subjectColor: "black", style: null },
      makeProviders(),
    );

    const candidate = assembleFunnelCandidate({
      subjectColor: "black",
      routeUcis: trunkUcis,
      trunkUcis,
      trunk: {
        edges: trunk.edges,
        personalAnchorPly: trunk.personalAnchorPly,
        reachLB: trunk.reachLB,
      },
      trunkSegments: trunk.trunkSegments,
      extension,
      styleMetrics: solidStyleMetrics({
        anchorAttribution: 0.2,
        attributionP75: 0.1,
        leakMoveIsCaptureOrCheck: false,
      }),
      riskMetrics: {
        personalEdgeGames: [10],
        extensionHasPersonal: false,
        onlyMoveCount: 0,
        evalSwingCp: 50,
        entryTransposes: false,
      },
      memTree: {
        leafCount: extension.leafCount,
        forkCount: 0,
        maxRepliesPerFork: 0,
        onlyMoveCount: 0,
        conceptFamilies: ["development"],
      },
      tendencyIds: ["quietPawnPush"],
      anchorAttribution: 0.2,
      entryEpd: entryEpdFromPath(trunkUcis, "black"),
      entryUcis: entryUcisFromPath(trunkUcis, "black"),
    });

    const report = await runSelectionFunnel([candidate], {
      auditLeafEval: async () => ({ evalCp: 20 }),
    });

    expect(report.packages.length).toBeGreaterThanOrEqual(1);
    const pkg = report.packages[0];
    const assembled = {
      entryRegion: { epd: candidate.entryEpd, ourEntryUcis: candidate.entryUcis },
      trunk: candidate.trunk,
      extension: {
        mainline: candidate.extension.mainline,
        branches: [],
      },
      style: pkg.primaryStyle,
      tendencyIds: candidate.tendencyIds,
      tier: null,
      riskTags: [],
      receipts: {},
      notes: [],
    };
    expect(validatePrepPackage(assembled).ok).toBe(true);
  });

  it("cross-tendency dedup: merged tendencyIds on one candidate", () => {
    const trunkUcis = ["e2e4", "c7c5"];
    const base = {
      subjectColor: "black",
      routeUcis: trunkUcis,
      trunkUcis,
      trunk: {
        edges: [personalEdge("e2e4", 10), personalEdge("c7c5", 10)],
        personalAnchorPly: 2,
        reachLB: 0.5,
      },
      trunkSegments: [{ k: 10, n: 20 }],
      extension: {
        ok: true,
        mainline: [engineEdge("g1f3"), cohortEdge("d7d6")],
        branches: [],
        leafCount: 1,
        endpointEvalCp: 20,
      },
      styleMetrics: solidStyleMetrics(),
      riskMetrics: {
        personalEdgeGames: [10],
        extensionHasPersonal: false,
        onlyMoveCount: 0,
        evalSwingCp: 50,
        entryTransposes: false,
      },
      memTree: {
        leafCount: 1,
        forkCount: 0,
        maxRepliesPerFork: 0,
        onlyMoveCount: 0,
        conceptFamilies: ["development"],
      },
      anchorAttribution: 5,
      entryEpd: entryEpdFromPath(trunkUcis, "black"),
      entryUcis: entryUcisFromPath(trunkUcis, "black"),
    };

    const merged = assembleFunnelCandidate({
      ...base,
      tendencyIds: ["featA", "featB"],
    });

    expect(merged.id).toBe("black:e2e4 c7c5");
    expect(merged.tendencyIds).toEqual(expect.arrayContaining(["featA", "featB"]));
    expect(merged.tendencyIds).toHaveLength(2);
  });
});