// Deterministic refutation scenarios for browser E2E (fixture-backed, no live Lichess).
import {
  ENGINE_AGG_MIN_ANALYZED_GAMES,
  ENGINE_AGG_MIN_COVERAGE_PCT,
} from "./scout-engine.js";
import * as scoutModule from "./scout.js";
import { fenAfterLine, triePathKey } from "./scout.js";
import { buildRefutations } from "./scout-refutation.js";
import { buildScoutSectionReport } from "./scout-report.js";

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
    ourReplyPv: null,
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

const pathUcis = ["e2e4", "c7c5"];
const confirmedHitRefutations = buildRefutations({
  weaknessTargets: [weaknessTarget()],
  color: "black",
  speedFilter: "all",
  baselineScorePct: 50,
  ...explorerContext(pathUcis),
  engineAgg: sufficientEngineAgg(),
  engineScan: {
    speedFilter: "all",
    scanRecords: [
      makeScanRecord("g1", pathUcis, "black"),
      makeScanRecord("g2", pathUcis, "black"),
    ],
  },
});

const deepScanGapRefutations = buildRefutations({
  weaknessTargets: [weaknessTarget()],
  color: "black",
  speedFilter: "all",
  baselineScorePct: 50,
  ...explorerContext(pathUcis),
  engineAgg: null,
  engineScan: null,
});

const oauthGapRefutations = buildRefutations({
  weaknessTargets: [weaknessTarget()],
  color: "black",
  speedFilter: "all",
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
});

export const SCOUT_E2E_REFUTATION_SCENARIOS = {
  confirmedHit: {
    refutations: confirmedHitRefutations,
    expect: { hit: true, deepScanGap: false, oauthGap: false },
  },
  deepScanGap: {
    refutations: deepScanGapRefutations,
    expect: { hit: false, deepScanGap: true, oauthGap: false },
  },
  oauthGap: {
    refutations: oauthGapRefutations,
    expect: { hit: true, deepScanGap: false, oauthGap: false },
  },
};

export function scoutE2eSeedGames() {
  return scoutE2eWeaknessGames();
}

/** Games where the Sicilian scores well below the opponent's overall baseline. */
export function scoutE2eWeaknessGames() {
  const games = [];
  for (let i = 0; i < 7; i += 1) {
    games.push({
      color: "black",
      score: 0,
      sans: ["e4", "c5"],
      ucis: ["e2e4", "c7c5"],
      rating: 1800,
      datestamp: 1000 + i * 1000,
      speed: "blitz",
      gameId: `e2e-c5-${i}`,
    });
  }
  for (let i = 0; i < 3; i += 1) {
    games.push({
      color: "black",
      score: 1,
      sans: ["e4", "e5"],
      ucis: ["e2e4", "e7e5"],
      rating: 1800,
      datestamp: 8000 + i * 1000,
      speed: "blitz",
      gameId: `e2e-e5-${i}`,
    });
  }
  return games;
}

const E2E_PATH_UCIS = ["e2e4", "c7c5"];

function e2eEngineScan() {
  return {
    speedFilter: "all",
    scanRecords: [
      makeScanRecord("e2e-g1", E2E_PATH_UCIS, "black"),
      makeScanRecord("e2e-g2", E2E_PATH_UCIS, "black"),
    ],
  };
}

/** Full Scout section HTML via buildScoutSectionReport (real prep-row IA). */
export function buildE2ePrepSection(scenarioId, escapeHtml) {
  const games = scoutE2eWeaknessGames();
  const profile = scoutModule.opponentProfile(games);
  const base = {
    games,
    profile,
    username: "e2e-fixture",
  };
  const common = {
    speedFilter: "all",
    escapeHtml,
    explorerReads: { available: false, reason: "auth" },
  };

  if (scenarioId === "deepScanGap") {
    return buildScoutSectionReport(scoutModule, base, "black", [], {
      ...common,
      engineAgg: null,
      engineScan: null,
    });
  }

  return buildScoutSectionReport(scoutModule, base, "black", [], {
    ...common,
    engineAgg: sufficientEngineAgg(),
    engineScan: e2eEngineScan(),
  });
}

export const SCOUT_E2E_PREP_SCENARIO_IDS = ["enginePrepCard", "deepScanGap", "engineNoOAuth"];

/** Alias legacy scenario ids to the real report fixtures. */
export function normalizeE2ePrepScenarioId(scenarioId) {
  if (scenarioId === "confirmedHit" || scenarioId === "oauthGap") return "enginePrepCard";
  return scenarioId;
}