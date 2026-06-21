import { describe, expect, it } from "vitest";

import {
  ENGINE_AGG_MIN_ANALYZED_GAMES,
  ENGINE_AGG_MIN_COVERAGE_PCT,
} from "./scout-engine.js";
import { MASTERS_MIN_TOTAL_GAMES } from "./scout-explorer.js";
import { fenAfterLine, triePathKey } from "./scout.js";
import {
  REFUTATION_MIN_ENGINE_PATH_GAMES,
  REFUTATION_MIN_EXPLORER_GAMES,
  REFUTATION_MIN_REPERTOIRE_GAMES,
  buildRefutations,
  collectRefutationCandidates,
  evaluateRefutationCandidate,
  refutationIdentity,
  scanRecordsForPath,
  sortRefutations,
  terminalMoveIsOpponent,
} from "./scout-refutation.js";

function weaknessTarget(overrides = {}) {
  return {
    sans: ["e4", "c5"],
    ucis: ["e2e4", "c7c5"],
    games: 10,
    scorePct: 35,
    share: 0.4,
    belowBaseline: 15,
    opportunity: 0.06,
    ...overrides,
  };
}

function mockMastersStats(moves, totalGames = 10_000) {
  return {
    totalGames: totalGames,
    opening: "B20",
    moves: moves.map((m) => ({
      uci: m.uci,
      san: m.san,
      total: Math.round(totalGames * m.share),
      share: m.share,
      whitePct: 40,
      drawPct: 20,
      blackPct: 40,
    })),
  };
}

function makeScanRecord(
  gameId,
  pathUcis,
  oppColor,
  {
    cpLoss = 40,
    opponentBestAlternativeUci = "e7e5",
    ourReplyUci = "b1c3",
    ourReplyPv = null,
    ply = null,
  } = {},
) {
  const lastIdx = pathUcis.length - 1;
  const movePly = ply ?? lastIdx;
  const parentKey = pathUcis.length > 1 ? triePathKey(pathUcis.slice(0, -1)) : "";
  const lastUci = pathUcis[pathUcis.length - 1];
  const move = {
    ply: movePly,
    pathKey: pathUcis.length > 1 ? parentKey : "",
    playedUci: lastUci,
    playedSan: oppColor === "white" && pathUcis.length === 1 ? "e4" : "c5",
    cpLoss,
    isInaccuracy: true,
    bestUci: opponentBestAlternativeUci,
    opponentBestAlternativeUci,
    ourReplyUci,
    ourReplyPv,
  };
  return {
    gameId,
    firstUci: pathUcis[0],
    firstSan: "e4",
    eligibleOpponentPlies: 1,
    analyzedOpponentPlies: 1,
    moves: [move],
    mistakes: [move],
    complete: true,
  };
}

function sufficientEngineAgg(overrides = {}) {
  return {
    sufficient: true,
    stale: false,
    analyzedGames: 10,
    eligibleGames: 10,
    coveragePct: 100,
    scopeLimited: false,
    maxGames: 60,
    minAnalyzedGames: ENGINE_AGG_MIN_ANALYZED_GAMES,
    minCoveragePct: ENGINE_AGG_MIN_COVERAGE_PCT,
    ...overrides,
  };
}

function explorerContext(pathUcis, { poolAuthFailed = false, poolShare = 0.1 } = {}) {
  const parentUcis = pathUcis.slice(0, -1);
  const probeFen = parentUcis.length ? fenAfterLine(parentUcis) : fenAfterLine([]);
  const lastUci = pathUcis[pathUcis.length - 1];
  const masters = mockMastersStats([
    { uci: "e2e4", san: "e4", share: 0.45 },
    { uci: "c7c5", san: "c5", share: 0.2 },
    { uci: lastUci, san: "c5", share: 0.2 },
  ]);
  const pool = mockMastersStats([{ uci: lastUci, san: "c5", share: poolShare }]);
  return {
    explorerReads: { available: true, poolAuthFailed },
    mastersByFen: new Map([[probeFen, masters]]),
    poolByFen: poolAuthFailed ? new Map() : new Map([[probeFen, pool]]),
  };
}

describe("terminalMoveIsOpponent", () => {
  it("requires the terminal ply to belong to the scouted colour", () => {
    expect(terminalMoveIsOpponent(["e2e4"], "white")).toBe(true);
    expect(terminalMoveIsOpponent(["e2e4", "c7c5"], "black")).toBe(true);
    expect(terminalMoveIsOpponent(["e2e4", "c7c5"], "white")).toBe(false);
    expect(terminalMoveIsOpponent(["e2e4"], "black")).toBe(false);
  });
});

describe("refutationIdentity", () => {
  it("uses color, speed, UCI path, and FEN as a stable key", () => {
    const ucis = ["e2e4", "c7c5"];
    const fen = fenAfterLine(ucis);
    const id = refutationIdentity({ color: "black", speed: "blitz", pathUcis: ucis, fen });
    expect(id).toBe(`black|blitz|${triePathKey(ucis)}|${fen}`);
    expect(refutationIdentity({ color: "black", speed: "blitz", pathUcis: ucis, fen })).toBe(id);
  });
});

describe("collectRefutationCandidates", () => {
  it("deduplicates the same path identity", () => {
    const targets = [
      weaknessTarget(),
      weaknessTarget({ games: 11, opportunity: 0.07 }),
    ];
    const candidates = collectRefutationCandidates(targets, { color: "black", speed: "all" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].games).toBe(10);
  });

  it("drops targets that end on our side's move", () => {
    const targets = [
      weaknessTarget({ sans: ["e4"], ucis: ["e2e4"] }),
      weaknessTarget(),
    ];
    const whiteCandidates = collectRefutationCandidates(targets, { color: "white", speed: "all" });
    expect(whiteCandidates).toHaveLength(1);
    expect(whiteCandidates[0].pathUcis).toEqual(["e2e4"]);

    const blackCandidates = collectRefutationCandidates(targets, { color: "black", speed: "all" });
    expect(blackCandidates).toHaveLength(1);
    expect(blackCandidates[0].pathUcis).toEqual(["e2e4", "c7c5"]);
  });
});

describe("evaluateRefutationCandidate", () => {
  it("synthesizes our reply for a black opponent line ending in c5", () => {
    const pathUcis = ["e2e4", "c7c5"];
    const candidate = collectRefutationCandidates([weaknessTarget()], {
      color: "black",
      speed: "all",
    })[0];
    const opponentBestAlternativeUci = "e7e5";
    const ourReplyUci = "b1c3";
    const result = evaluateRefutationCandidate(candidate, {
      baselineScorePct: 50,
      ...explorerContext(pathUcis),
      engineAgg: sufficientEngineAgg(),
      engineScan: {
        speedFilter: "all",
        scanRecords: [
          makeScanRecord("g1", pathUcis, "black", {
            opponentBestAlternativeUci,
            ourReplyUci,
          }),
          makeScanRecord("g2", pathUcis, "black", {
            opponentBestAlternativeUci,
            ourReplyUci: "g1f3",
          }),
        ],
      },
      speedFilter: "all",
    });

    expect(result.blockedBy).toEqual([]);
    expect(result.refutation?.suggestedUci).toBe(ourReplyUci);
    expect(result.refutation?.opponentBestAlternativeUci).toBe(opponentBestAlternativeUci);
    expect(result.refutation?.suggestedUci).not.toBe(opponentBestAlternativeUci);
    expect(result.refutation?.source).toBe("engine");
  });

  it("synthesizes our reply for a white opponent line ending in e4", () => {
    const pathUcis = ["e2e4"];
    const target = weaknessTarget({ sans: ["e4"], ucis: pathUcis });
    const candidate = collectRefutationCandidates([target], {
      color: "white",
      speed: "all",
    })[0];
    const opponentBestAlternativeUci = "d2d4";
    const ourReplyUci = "c7c5";
    const result = evaluateRefutationCandidate(candidate, {
      baselineScorePct: 50,
      explorerReads: { available: true, poolAuthFailed: false },
      mastersByFen: new Map([
        [
          fenAfterLine([]),
          mockMastersStats([
            { uci: "e2e4", san: "e4", share: 0.4 },
            { uci: "d2d4", san: "d4", share: 0.35 },
          ]),
        ],
      ]),
      poolByFen: new Map([
        [fenAfterLine([]), mockMastersStats([{ uci: "e2e4", san: "e4", share: 0.2 }])],
      ]),
      engineAgg: sufficientEngineAgg(),
      engineScan: {
        speedFilter: "all",
        scanRecords: [
          makeScanRecord("g1", pathUcis, "white", {
            opponentBestAlternativeUci,
            ourReplyUci,
            ply: 0,
          }),
          makeScanRecord("g2", pathUcis, "white", {
            opponentBestAlternativeUci,
            ourReplyUci: "e7e5",
            ply: 0,
          }),
        ],
      },
      speedFilter: "all",
    });

    expect(result.blockedBy).toEqual([]);
    expect(result.refutation?.suggestedUci).toBe(ourReplyUci);
    expect(result.refutation?.suggestedUci).not.toBe(opponentBestAlternativeUci);
  });

  it("blocks when our reply is unavailable", () => {
    const pathUcis = ["e2e4", "c7c5"];
    const candidate = collectRefutationCandidates([weaknessTarget()], {
      color: "black",
      speed: "all",
    })[0];
    const result = evaluateRefutationCandidate(candidate, {
      baselineScorePct: 50,
      ...explorerContext(pathUcis),
      engineAgg: sufficientEngineAgg(),
      engineScan: {
        speedFilter: "all",
        scanRecords: [
          makeScanRecord("g1", pathUcis, "black", { ourReplyUci: null }),
          makeScanRecord("g2", pathUcis, "black", { ourReplyUci: null }),
        ],
      },
      speedFilter: "all",
    });

    expect(result.refutation).toBeNull();
    expect(result.blockedBy.some((b) => b.layer === "engine" && b.code === "reply-unavailable")).toBe(
      true,
    );
  });

  it("blocks engine when speed filter mismatches the scan", () => {
    const pathUcis = ["e2e4", "c7c5"];
    const candidate = collectRefutationCandidates([weaknessTarget()], {
      color: "black",
      speed: "blitz",
    })[0];
    const result = evaluateRefutationCandidate(candidate, {
      baselineScorePct: 50,
      ...explorerContext(pathUcis),
      engineAgg: sufficientEngineAgg(),
      engineScan: {
        speedFilter: "rapid",
        scanRecords: [
          makeScanRecord("g1", pathUcis, "black"),
          makeScanRecord("g2", pathUcis, "black"),
        ],
      },
      speedFilter: "blitz",
    });

    expect(result.refutation).toBeNull();
    expect(result.blockedBy.some((b) => b.layer === "engine" && b.code === "speed-mismatch")).toBe(
      true,
    );
  });

  it("infers refutation when explorer auth fails but engine scan is available", () => {
    const pathUcis = ["e2e4", "c7c5"];
    const candidate = collectRefutationCandidates([weaknessTarget()], {
      color: "black",
      speed: "all",
    })[0];
    const result = evaluateRefutationCandidate(candidate, {
      baselineScorePct: 50,
      explorerReads: { available: false, reason: "auth" },
      engineAgg: sufficientEngineAgg(),
      engineScan: {
        speedFilter: "all",
        scanRecords: [
          makeScanRecord("g1", pathUcis, "black"),
          makeScanRecord("g2", pathUcis, "black"),
        ],
      },
      speedFilter: "all",
    });

    expect(result.refutation?.suggestedUci).toBe("b1c3");
    expect(result.refutation?.suggestedSan).toBe("Nc3");
    expect(result.blockedBy.some((b) => b.layer === "explorer")).toBe(false);
  });

  it("infers refutation when pool auth fails but engine scan is available", () => {
    const pathUcis = ["e2e4", "c7c5"];
    const candidate = collectRefutationCandidates([weaknessTarget()], {
      color: "black",
      speed: "all",
    })[0];
    const result = evaluateRefutationCandidate(candidate, {
      baselineScorePct: 50,
      ...explorerContext(pathUcis, { poolAuthFailed: true }),
      engineAgg: sufficientEngineAgg(),
      engineScan: {
        speedFilter: "all",
        scanRecords: [
          makeScanRecord("g1", pathUcis, "black"),
          makeScanRecord("g2", pathUcis, "black"),
        ],
      },
      speedFilter: "all",
    });

    expect(result.refutation?.suggestedUci).toBe("b1c3");
    expect(result.blockedBy.some((b) => b.layer === "explorer" && b.code === "pool-auth")).toBe(
      false,
    );
  });

  it("blocks engine when coverage is insufficient on the path", () => {
    const pathUcis = ["e2e4", "c7c5"];
    const candidate = collectRefutationCandidates([weaknessTarget()], {
      color: "black",
      speed: "all",
    })[0];
    const result = evaluateRefutationCandidate(candidate, {
      baselineScorePct: 50,
      ...explorerContext(pathUcis),
      engineAgg: sufficientEngineAgg({ sufficient: false, coveragePct: 40 }),
      engineScan: {
        speedFilter: "all",
        scanRecords: [makeScanRecord("g1", pathUcis, "black")],
      },
      speedFilter: "all",
    });

    expect(result.refutation).toBeNull();
    expect(
      result.blockedBy.some((b) => b.layer === "engine" && b.code === "insufficient-coverage"),
    ).toBe(true);
    expect(
      result.blockedBy.some(
        (b) => b.layer === "engine" && b.code === "insufficient-path-games",
      ),
    ).toBe(true);
  });
});

describe("scanRecordsForPath", () => {
  it("matches games that played the full opponent line", () => {
    const pathUcis = ["e2e4", "c7c5"];
    const records = [
      makeScanRecord("g1", pathUcis, "black"),
      makeScanRecord("g2", ["e2e4", "e7e5"], "black"),
      makeScanRecord("g3", pathUcis, "black"),
    ];
    const matched = scanRecordsForPath(records, pathUcis);
    expect(matched.map((r) => r.gameId).sort()).toEqual(["g1", "g3"]);
    expect(matched.length).toBeGreaterThanOrEqual(REFUTATION_MIN_ENGINE_PATH_GAMES);
  });
});

describe("buildRefutations", () => {
  it("sorts refutations stably by score then identity", () => {
    const pathA = ["e2e4", "c7c5"];
    const pathB = ["d2d4", "d7d5"];
    const targets = [
      weaknessTarget({ ucis: pathB, sans: ["d4", "d5"], opportunity: 0.05, games: 8 }),
      weaknessTarget({ opportunity: 0.05 }),
    ];
    const parentA = fenAfterLine(["e2e4"]);
    const parentB = fenAfterLine(["d2d4"]);

    const results = buildRefutations({
      weaknessTargets: targets,
      color: "black",
      speedFilter: "all",
      baselineScorePct: 50,
      explorerReads: { available: true, poolAuthFailed: false },
      mastersByFen: new Map([
        [fenAfterLine([]), mockMastersStats([{ uci: "e2e4", san: "e4", share: 0.4 }])],
        [parentA, mockMastersStats([{ uci: "c7c5", san: "c5", share: 0.2 }])],
        [parentB, mockMastersStats([{ uci: "d7d5", san: "d5", share: 0.2 }])],
      ]),
      poolByFen: new Map([
        [parentA, mockMastersStats([{ uci: "c7c5", san: "c5", share: 0.1 }])],
        [parentB, mockMastersStats([{ uci: "d7d5", san: "d5", share: 0.1 }])],
      ]),
      engineAgg: sufficientEngineAgg(),
      engineScan: {
        speedFilter: "all",
        scanRecords: [
          makeScanRecord("g1", pathA, "black"),
          makeScanRecord("g2", pathA, "black"),
          makeScanRecord("g3", pathB, "black"),
          makeScanRecord("g4", pathB, "black"),
        ],
      },
    });

    expect(results.length).toBe(2);
    const sorted = sortRefutations([...results].reverse());
    expect(sorted.map((r) => r.identity)).toEqual(results.map((r) => r.identity));
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it("exports gate constants aligned with scout modules", () => {
    expect(REFUTATION_MIN_REPERTOIRE_GAMES).toBeGreaterThanOrEqual(REFUTATION_MIN_EXPLORER_GAMES);
    expect(REFUTATION_MIN_ENGINE_PATH_GAMES).toBeGreaterThanOrEqual(2);
    expect(MASTERS_MIN_TOTAL_GAMES).toBeGreaterThan(0);
  });
});