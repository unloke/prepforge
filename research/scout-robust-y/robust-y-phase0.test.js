import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  RY_PROTOCOL_ID,
  RY_STATES,
  RY_VERDICTS,
  RY_V2_X_SOURCE,
  assertFreezeCohortRoot,
  assertRyStateTransition,
  auditPlayerColorTimeline,
  buildDecisionWindowsForPlayerColor,
  buildEligibleCutoffs,
  buildRobustYManifest,
  buildRobustYSummary,
  canonicalizePhase0Units,
  checkRobustYArtifactPresence,
  computeFuturePrefixReentry,
  computeManifestSha256,
  manifestBytesForHash,
  computePrefixSupport,
  computeRobustYReportSha256,
  computeScientificPayloadSha256,
  computeUnitContentHash,
  describePhase0StuckState,
  discoverCohortPairs,
  evaluatePhase0Unit,
  inventoryGroundedX,
  listPhase0BurnMarkers,
  refuseIfPhase0Burned,
  runPhase0Inventory,
  selectV2TrainOnlyX,
  sortGamesChronologically,
  splitTrainFuture,
  utcDayKey,
  validateGameRecordForPhase0,
  validateRobustYProtocol,
  verifyRobustYStudy,
} from "./robust-y-phase0.js";
import { lineLastSeen } from "../../web-src/scout-stats.js";
import {
  SCOUT_BRANCH_SCORE_CAP,
  branchPathKey,
  buildOpeningTrie,
  isEarlyResignCollapse,
  rankGamePlan,
  rankedOpeningBranches,
} from "../../web-src/scout.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const PROTOCOL_PATH = join(HERE, "robust-y-p1.protocol.json");
const COHORT_ROOT = join(ROOT, "tmp/cohort-unbrainless87");

function loadProtocol() {
  return JSON.parse(readFileSync(PROTOCOL_PATH, "utf8"));
}

function sansForUcis(ucis) {
  return (ucis || []).map((uci) => uci);
}

function makeGame({
  gameId,
  color,
  ucis,
  datestamp,
  score = 0.5,
  status = "mate",
}) {
  const sans = sansForUcis(ucis);
  return {
    gameId,
    color,
    ucis,
    sans,
    openingUcis: ucis,
    openingSans: sans,
    datestamp,
    score,
    speed: "blitz",
    status,
    totalPly: ucis.length,
  };
}

function synthOpeningGames(playerId, countPerColor, {
  whiteMain = ["e2e4", "c7c5", "g1f3", "d7d6"],
  blackMain = ["e2e4", "c7c5", "g1f3", "b8c6"],
} = {}) {
  const games = [];
  for (let i = 0; i < countPerColor; i += 1) {
    const day = 1_700_000_000_000 + i * 86_400_000;
    const lateNonMatching = i >= 40;
    const whiteUcis = lateNonMatching
      ? ["d2d4", "g8f6", "c2c4"]
      : i % 3 === 0
        ? whiteMain
        : i % 3 === 1
          ? ["e2e4", "c7c5", "g1f3", "d7d6"]
          : ["e2e4", "e7e5", "g1f3", "b8c6"];
    const blackUcis = lateNonMatching
      ? ["d2d4", "d7d5", "c2c4"]
      : i % 3 === 0
        ? blackMain
        : i % 3 === 1
          ? ["e2e4", "c7c5", "g1f3", "b8c6"]
          : ["d2d4", "g8f6", "c2c4", "e7e6"];
    games.push(makeGame({
      gameId: `${playerId}-w-${i}`,
      color: "white",
      ucis: whiteUcis,
      datestamp: day,
    }));
    games.push(makeGame({
      gameId: `${playerId}-b-${i}`,
      color: "black",
      ucis: blackUcis,
      datestamp: day + 43_200_000,
    }));
  }
  return games;
}

function synthPanelPlayers(playerCount = 12, gamesPerColor = 80) {
  const rows = [];
  for (let p = 0; p < playerCount; p += 1) {
    const playerId = `synth-player-${String(p).padStart(2, "0")}`;
    rows.push({ playerId, games: synthOpeningGames(playerId, gamesPerColor) });
  }
  return rows;
}

const RECURRENCE_TRAIN_UCIS = ["e2e4", "c7c5", "g1f3", "d7d6"];
const RECURRENCE_NONMATCH_UCIS = ["d2d4", "g8f6", "c2c4", "e7e6"];
const FUTURE_WINDOW_CUTOFFS = [30, 40, 50, 60];

function isFutureWindowIndex(index) {
  return FUTURE_WINDOW_CUTOFFS.some((cutoff) => index >= cutoff && index < cutoff + 10);
}

function synthRecurrencePanel(playerCount = 12, gamesPerColor = 80, { futureMatchesTrain }) {
  const rows = [];
  const singleCutoffPanel = gamesPerColor <= 40;
  for (let p = 0; p < playerCount; p += 1) {
    const playerId = `rec-${String(p).padStart(2, "0")}`;
    const games = [];
    for (let i = 0; i < gamesPerColor; i += 1) {
      const day = 1_700_000_000_000 + i * 86_400_000;
      const inFuture = singleCutoffPanel
        ? i >= 30
        : isFutureWindowIndex(i);
      const pickUcis = futureMatchesTrain || !inFuture
        ? RECURRENCE_TRAIN_UCIS
        : RECURRENCE_NONMATCH_UCIS;
      games.push(makeGame({
        gameId: `${playerId}-w-${i}`,
        color: "white",
        ucis: pickUcis,
        datestamp: day,
      }));
      games.push(makeGame({
        gameId: `${playerId}-b-${i}`,
        color: "black",
        ucis: futureMatchesTrain || !inFuture
          ? RECURRENCE_TRAIN_UCIS
          : RECURRENCE_NONMATCH_UCIS,
        datestamp: day + 43_200_000,
      }));
    }
    rows.push({ playerId, games });
  }
  return rows;
}

function filterTrainGamesForV2(trainGames, subjectColor) {
  return (trainGames || [])
    .filter((g) => g?.color === subjectColor)
    .filter((g) => !isEarlyResignCollapse(g))
    .filter((g) => Array.isArray(g?.ucis) && g.ucis.length > 0);
}

/** Independent scout-report.js no-enrichment weakness-target call sequence (production imports only). */
function independentScoutReportNoEnrichmentSequence(trainGames, subjectColor) {
  const speedFilter = "all";
  const filtered = filterTrainGamesForV2(trainGames, subjectColor);
  if (!filtered.length) return null;

  const trie = buildOpeningTrie(filtered, subjectColor, { speedFilter });
  if (!trie?.gameCount) return null;

  const baseline = trie?.count ? Math.round((trie.score / trie.count) * 100) : 0;
  const { branches, ancestorFreq } = rankedOpeningBranches(filtered, subjectColor, {
    speedFilter,
    limit: SCOUT_BRANCH_SCORE_CAP,
  });
  if (!branches.length) return null;

  const ranked = rankGamePlan(branches, baseline, {
    oppColor: subjectColor,
    games: filtered,
    speedFilter,
    lineLastSeen,
    ancestorFreq,
    limit: 1,
  });
  return ranked[0] || null;
}

describe("robust-y protocol lock", () => {
  it("accepts the canonical protocol", () => {
    const protocol = loadProtocol();
    const v = validateRobustYProtocol(protocol);
    expect(v.ok).toBe(true);
    expect(protocol.protocolId).toBe(RY_PROTOCOL_ID);
    expect(protocol.role).toBe("exploratory-zero-network-robust-y-phase0-analysis-lock");
    expect(protocol.productAuthorization).toBe(false);
    expect(protocol.preserveV2Regardless).toBe(true);
    expect(protocol.futureP1.implementedInPhase0).toBe(false);
  });

  const mutationCases = [
    ["productAuthorization", (p) => ({ ...p, productAuthorization: true })],
    ["cannotAuthorizeCards", (p) => ({ ...p, cannotAuthorizeCards: false })],
    ["phase0Gates.minTotalUsableUnits", (p) => ({
      ...p,
      phase0Gates: { ...p.phase0Gates, minTotalUsableUnits: 39 },
    })],
    ["inputs.cohortRoot", (p) => ({
      ...p,
      inputs: { ...p.inputs, cohortRoot: "tmp/other" },
    })],
    ["inputs.forbiddenInputs", (p) => ({
      ...p,
      inputs: { ...p.inputs, forbiddenInputs: ["network"] },
    })],
    ["xSelection.v2Pipeline.candidateCap", (p) => ({
      ...p,
      xSelection: {
        ...p.xSelection,
        v2Pipeline: { ...p.xSelection.v2Pipeline, candidateCap: 47 },
      },
    })],
    ["xSelection.groundedInventory.maxPlies", (p) => ({
      ...p,
      xSelection: {
        ...p.xSelection,
        groundedInventory: { ...p.xSelection.groundedInventory, maxPlies: 11 },
      },
    })],
    ["futureP1.selectionDepth", (p) => ({
      ...p,
      futureP1: { ...p.futureP1, selectionDepth: 7 },
    })],
    ["lifecycle.finalReportLast", (p) => ({
      ...p,
      lifecycle: { ...p.lifecycle, finalReportLast: false },
    })],
    ["futureArms.primary.name", (p) => ({
      ...p,
      futureArms: {
        ...p.futureArms,
        primary: { ...p.futureArms.primary, name: "other" },
      },
    })],
    ["futureP1.replyUncertainty", (p) => ({
      ...p,
      futureP1: { ...p.futureP1, replyUncertainty: "other" },
    })],
    ["futureP1.intrinsicV.formula", (p) => ({
      ...p,
      futureP1: {
        ...p.futureP1,
        intrinsicV: { ...p.futureP1.intrinsicV, formula: "other" },
      },
    })],
    ["futureP1.selectionRule", (p) => ({
      ...p,
      futureP1: { ...p.futureP1, selectionRule: "other" },
    })],
    ["futureP1.auditRule", (p) => ({
      ...p,
      futureP1: { ...p.futureP1, auditRule: "other" },
    })],
    ["futureP1.unitWeight.abstainRule", (p) => ({
      ...p,
      futureP1: {
        ...p.futureP1,
        unitWeight: { ...p.futureP1.unitWeight, abstainRule: "other" },
      },
    })],
    ["futureP1.phase1aRequirement", (p) => ({
      ...p,
      futureP1: { ...p.futureP1, phase1aRequirement: "other" },
    })],
    ["futureP1.conditionalExploratoryNote", (p) => ({
      ...p,
      futureP1: { ...p.futureP1, conditionalExploratoryNote: "other" },
    })],
    ["futureP1.primaryDelta.xFixedNote", (p) => ({
      ...p,
      futureP1: {
        ...p.futureP1,
        primaryDelta: { ...p.futureP1.primaryDelta, xFixedNote: "other" },
      },
    })],
    ["xSelection.futureRecurrence.rule", (p) => ({
      ...p,
      xSelection: {
        ...p.xSelection,
        futureRecurrence: { ...p.xSelection.futureRecurrence, rule: "other" },
      },
    })],
    ["lifecycle.protocolSha256Convention", (p) => ({
      ...p,
      lifecycle: { ...p.lifecycle, protocolSha256Convention: "other" },
    })],
    ["lifecycle.reportHashField", (p) => ({
      ...p,
      lifecycle: { ...p.lifecycle, reportHashField: "other" },
    })],
    ["lifecycle.reportHashOmitField", (p) => ({
      ...p,
      lifecycle: { ...p.lifecycle, reportHashOmitField: false },
    })],
    ["reportHash.canonicalJson", (p) => ({
      ...p,
      reportHash: { ...p.reportHash, canonicalJson: "other" },
    })],
    ["claimBoundary.exploratoryNote", (p) => ({
      ...p,
      claimBoundary: { ...p.claimBoundary, exploratoryNote: "other" },
    })],
    ["claimBoundary.phase0Scope", (p) => ({
      ...p,
      claimBoundary: { ...p.claimBoundary, phase0Scope: "other" },
    })],
  ];

  it.each(mutationCases)("rejects tampered field %s", (_label, mutate) => {
    const protocol = loadProtocol();
    expect(validateRobustYProtocol(mutate(protocol)).ok).toBe(false);
  });
});

describe("cohort root binding", () => {
  it("accepts only the protocol cohort root", () => {
    const protocol = loadProtocol();
    const ok = assertFreezeCohortRoot({
      protocol,
      cohortRootAbs: join(ROOT, protocol.inputs.cohortRoot),
      rootDir: ROOT,
    });
    expect(ok.ok).toBe(true);
    expect(ok.cohortRoot).toBe("tmp/cohort-unbrainless87");
  });

  it("rejects alternate 17-pair roots", () => {
    const protocol = loadProtocol();
    const bad = assertFreezeCohortRoot({
      protocol,
      cohortRootAbs: join(ROOT, "tmp/other-cohort"),
      rootDir: ROOT,
    });
    expect(bad.ok).toBe(false);
  });

  it("rejects traversal and outside-root cohort paths fail-closed", () => {
    const protocol = loadProtocol();
    const traversal = assertFreezeCohortRoot({
      protocol,
      cohortRootAbs: join(ROOT, "tmp/cohort-unbrainless87/../../../outside"),
      rootDir: ROOT,
    });
    expect(traversal.ok).toBe(false);
    expect(traversal.errors[0]).toMatch(/outside project root|traversal/);

    const outside = assertFreezeCohortRoot({
      protocol,
      cohortRootAbs: "D:/definitely-not-the-cohort-root",
      rootDir: ROOT,
    });
    expect(outside.ok).toBe(false);
    expect(outside.actual).toBeNull();
  });

  it("records cohortRoot on manifest", () => {
    const protocol = loadProtocol();
    const manifest = buildRobustYManifest({
      protocol,
      protocolSha256: "abc",
      cohortRoot: protocol.inputs.cohortRoot,
      players: [{ playerId: "p1", gamesPath: "g", gamesSha256: "a", dumpPath: "d", dumpSha256: "b", gameCount: 1 }],
    });
    expect(manifest.cohortRoot).toBe("tmp/cohort-unbrainless87");
  });
});

describe("cohort pair discovery", () => {
  it("ignores fit JSON and requires game+dump pairs", () => {
    const pairs = discoverCohortPairs([
      { name: "alice.json" },
      { name: "alice-bias.ndjson" },
      { name: "alice-fit.json" },
    ]);
    expect(pairs.map((p) => p.playerId)).toEqual(["alice"]);
    expect(() => discoverCohortPairs([
      { name: "bob.json" },
      { name: "carol-bias.ndjson" },
    ])).toThrow(/cohort pair mismatch/);
  });
});

describe("chronological decision windows", () => {
  const games = sortGamesChronologically(
    Array.from({ length: 75 }, (_, i) => makeGame({
      gameId: `g${String(i).padStart(3, "0")}`,
      color: "white",
      ucis: ["e2e4", "e7e5"],
      datestamp: 1_700_000_000_000 + i * 86_400_000,
    })),
  );

  it("uses exact 30/10/stride and keeps latest four cutoffs", () => {
    expect(buildEligibleCutoffs(games.length)).toEqual([30, 40, 50, 60]);
    const windows = buildDecisionWindowsForPlayerColor(games, "white");
    expect(windows).toHaveLength(4);
    expect(windows.map((w) => w.cutoff)).toEqual([30, 40, 50, 60]);
    for (const w of windows) {
      expect(w.trainGameCount).toBe(w.cutoff);
      expect(w.futureGameCount).toBe(10);
      expect(w.leakageFree).toBe(true);
      expect(w.trainFutureOverlap).toEqual([]);
    }
  });

  it("produces non-overlapping future windows", () => {
    const windows = buildDecisionWindowsForPlayerColor(games, "white");
    for (let i = 1; i < windows.length; i += 1) {
      const prev = new Set(windows[i - 1].futureGameIds);
      const cur = windows[i].futureGameIds;
      expect(cur.some((id) => prev.has(id))).toBe(false);
    }
  });

  it("orders units canonically by player, white-before-black, cutoff", () => {
    const units = canonicalizePhase0Units([
      { playerId: "b", subjectColor: "black", cutoff: 30 },
      { playerId: "a", subjectColor: "black", cutoff: 40 },
      { playerId: "a", subjectColor: "white", cutoff: 50 },
      { playerId: "a", subjectColor: "white", cutoff: 30 },
    ]);
    expect(units.map((u) => `${u.playerId}|${u.subjectColor}|${u.cutoff}`)).toEqual([
      "a|white|30",
      "a|white|50",
      "a|black|40",
      "b|black|30",
    ]);
  });
});

describe("UTC calendar distinct dates", () => {
  const prefix = ["e2e4", "c7c5", "g1f3"];

  it("counts one UTC day when timestamps differ only by ms on the same day", () => {
    const day = 1_700_000_000_000;
    const games = [
      makeGame({ gameId: "a", color: "white", ucis: prefix, datestamp: day }),
      makeGame({ gameId: "b", color: "white", ucis: prefix, datestamp: day + 3_600_000 }),
    ];
    const support = computePrefixSupport(games, prefix);
    expect(support.distinctDates).toBe(1);
    expect(support.distinctGames).toBe(2);
    const inv = inventoryGroundedX(games, "white");
    expect(inv.phase0S1Eligible).toBe(false);
  });

  it("counts two UTC days across different calendar days", () => {
    const games = [
      makeGame({ gameId: "a", color: "white", ucis: prefix, datestamp: 1_700_000_000_000 }),
      makeGame({ gameId: "b", color: "white", ucis: prefix, datestamp: 1_700_000_000_000 + 86_400_000 }),
    ];
    const support = computePrefixSupport(games, prefix);
    expect(support.distinctDates).toBe(2);
    const inv = inventoryGroundedX(games, "white");
    expect(inv.phase0S1Eligible).toBe(true);
  });

  it("parses YYYY-MM-DD datestamp strings", () => {
    const g = makeGame({ gameId: "d", color: "white", ucis: prefix, datestamp: "2024-03-15" });
    expect(utcDayKey(g)).toBe("2024-03-15");
  });
});

describe("data quality and window integrity", () => {
  it("flags duplicate game IDs and missing dates as INVALID data quality", () => {
    const games = [
      makeGame({ gameId: "dup", color: "white", ucis: ["e2e4", "e7e5"], datestamp: 1_700_000_000_000 }),
      makeGame({ gameId: "dup", color: "white", ucis: ["e2e4", "e7e5"], datestamp: 1_700_086_400_000 }),
      makeGame({ gameId: "nodate", color: "white", ucis: ["e2e4", "e7e5"], datestamp: null }),
    ];
    const audit = auditPlayerColorTimeline(games, "white");
    expect(audit.ok).toBe(false);
    expect(audit.issues.some((i) => i.reason === "duplicate-game-id")).toBe(true);
    expect(audit.issues.some((i) => i.reason === "missing-or-invalid-date")).toBe(true);
  });

  it("flags sans/ucis length mismatch before branch extraction", () => {
    const bad = makeGame({ gameId: "bad", color: "white", ucis: ["e2e4", "e7e5"], datestamp: 1 });
    bad.sans = ["e4"];
    delete bad.openingSans;
    expect(validateGameRecordForPhase0(bad).reason).toBe("sans-ucis-length-mismatch");
  });

  it("marks units with data-quality failures INVALID in panel", () => {
    const protocol = loadProtocol();
    const badGames = Array.from({ length: 40 }, (_, i) => makeGame({
      gameId: i === 5 ? "" : `g${i}`,
      color: "white",
      ucis: ["e2e4", "c7c5", "g1f3", "d7d6"],
      datestamp: 1_700_000_000_000 + i * 86_400_000,
    }));
    const report = runPhase0Inventory({
      protocol,
      playerGames: [{ playerId: "bad-player", games: badGames }],
    });
    expect(report.verdict).toBe(RY_VERDICTS.INVALID);
    expect(report.panel.dataQualityFailureCount).toBeGreaterThan(0);
    expect(report.panel.gateResults.noDataQualityFailures).toBe(false);
  });
});

describe("v2 train-only X selection", () => {
  const trainGames = [
    makeGame({ gameId: "t1", color: "white", ucis: ["e2e4", "c7c5", "g1f3", "d7d6"], datestamp: 1_700_000_000_000 }),
    makeGame({ gameId: "t2", color: "white", ucis: ["e2e4", "c7c5", "g1f3", "d7d6"], datestamp: 1_700_086_400_000 }),
    makeGame({ gameId: "t3", color: "white", ucis: ["e2e4", "c7c5", "g1f3", "b8c6"], datestamp: 1_700_172_800_000 }),
    makeGame({ gameId: "t4", color: "white", ucis: ["e2e4", "e7e5", "g1f3"], datestamp: 1_700_259_200_000 }),
    makeGame({ gameId: "t5", color: "white", ucis: ["e2e4", "e7e5", "g1f3"], datestamp: 1_700_345_600_000 }),
    makeGame({ gameId: "t6", color: "white", ucis: ["e2e4", "e7e5", "g1f3"], datestamp: 1_700_432_000_000 }),
    makeGame({ gameId: "t7", color: "white", ucis: ["e2e4", "e7e5", "g1f3"], datestamp: 1_700_518_400_000 }),
  ];

  it("is stable under future-game perturbation but changes when train changes", () => {
    const x1 = selectV2TrainOnlyX(trainGames, "white");
    const futureOnly = [
      ...trainGames,
      makeGame({ gameId: "f1", color: "white", ucis: ["d2d4", "d7d5", "c2c4", "e7e6"], datestamp: 99 }),
    ];
    const x2 = selectV2TrainOnlyX(futureOnly.slice(0, 7), "white");
    expect(x2.line).toBe(x1.line);
    const alteredTrain = trainGames.slice(0, 6).map((g) => makeGame({
      ...g,
      ucis: ["d2d4", "g8f6", "c2c4", "e7e6"],
      datestamp: g.datestamp,
    }));
    const x3 = selectV2TrainOnlyX(alteredTrain, "white");
    expect(x3.source).toBe(RY_V2_X_SOURCE);
    expect(x3.abstentionReason).toBeNull();
    expect(x3.line).not.toBe(x1.line);
  });

  it("matches independent production scout-report no-enrichment sequence", () => {
    const independent = independentScoutReportNoEnrichmentSequence(trainGames, "white");
    const selected = selectV2TrainOnlyX(trainGames, "white");
    expect(independent).toBeTruthy();
    expect(selected.line).toBe(independent.line || branchPathKey(independent.ucis));
    expect(selected.ucis).toEqual(independent.ucis);
    expect(selected.baselineScorePct).toBe(
      independent.baselineScorePct ?? Math.round((independent.scorePct ?? 0)),
    );
  });

  it("uses production default branch cap without trie enrichment", () => {
    const manyBranchGames = [];
    for (let i = 0; i < 55; i += 1) {
      const branch = i % 2 === 0
        ? ["e2e4", "c7c5", "g1f3", "d7d6"]
        : ["d2d4", "g8f6", "c2c4", "e7e6"];
      manyBranchGames.push(makeGame({
        gameId: `mb${i}`,
        color: "white",
        ucis: branch,
        datestamp: 1_700_000_000_000 + i * 86_400_000,
      }));
    }
    const independent = independentScoutReportNoEnrichmentSequence(manyBranchGames, "white");
    const selected = selectV2TrainOnlyX(manyBranchGames, "white");
    expect(selected.line).toBe(independent.line || branchPathKey(independent.ucis));
    expect(SCOUT_BRANCH_SCORE_CAP).toBe(48);
  });

  it("resolves ties with lineLastSeen on equal reproducibility branches", () => {
    const tieGames = [];
    for (let i = 0; i < 6; i += 1) {
      tieGames.push(makeGame({
        gameId: `sic${i}`,
        color: "white",
        ucis: ["e2e4", "c7c5", "g1f3", "d7d6"],
        datestamp: 1_000 + i,
      }));
      tieGames.push(makeGame({
        gameId: `ind${i}`,
        color: "white",
        ucis: ["d2d4", "g8f6", "c2c4", "e7e6"],
        datestamp: 2_000 + i,
      }));
    }
    tieGames.push(makeGame({
      gameId: "sic-new",
      color: "white",
      ucis: ["e2e4", "c7c5", "g1f3", "d7d6"],
      datestamp: 9_999,
    }));
    const independent = independentScoutReportNoEnrichmentSequence(tieGames, "white");
    const selected = selectV2TrainOnlyX(tieGames, "white");
    expect(independent.ucis[0]).toBe("e2e4");
    expect(selected.line).toBe(independent.line || branchPathKey(independent.ucis));
    expect(independent.lastSeen?.lastDatestamp).toBe(9_999);
  });

  it("ends on opponent move for white and black subject colors", () => {
    const whiteX = selectV2TrainOnlyX(trainGames, "white");
    expect(whiteX.abstentionReason).toBeNull();
    expect(whiteX.lengthPlies % 2).toBe(1);

    const blackTrain = [
      makeGame({ gameId: "b1", color: "black", ucis: ["e2e4", "c7c5", "g1f3", "d7d6"], datestamp: 1 }),
      makeGame({ gameId: "b2", color: "black", ucis: ["e2e4", "c7c5", "g1f3", "d7d6"], datestamp: 2 }),
      makeGame({ gameId: "b3", color: "black", ucis: ["e2e4", "c7c5", "g1f3", "b8c6"], datestamp: 3 }),
      makeGame({ gameId: "b4", color: "black", ucis: ["d2d4", "g8f6", "c2c4"], datestamp: 4 }),
      makeGame({ gameId: "b5", color: "black", ucis: ["d2d4", "g8f6", "c2c4"], datestamp: 5 }),
      makeGame({ gameId: "b6", color: "black", ucis: ["d2d4", "g8f6", "c2c4"], datestamp: 6 }),
      makeGame({ gameId: "b7", color: "black", ucis: ["d2d4", "g8f6", "c2c4"], datestamp: 7 }),
    ];
    const blackX = selectV2TrainOnlyX(blackTrain, "black");
    expect(blackX.abstentionReason).toBeNull();
    expect(blackX.lengthPlies % 2).toBe(0);
  });

  it("records exact prefix support, distinct dates, and future re-entry", () => {
    const x = selectV2TrainOnlyX(trainGames, "white");
    const support = computePrefixSupport(trainGames, x.ucis);
    expect(support.distinctGames).toBeGreaterThanOrEqual(2);
    expect(support.distinctDates).toBeGreaterThanOrEqual(2);
    const future = [
      makeGame({ gameId: "f1", color: "white", ucis: [...x.ucis, "b8c6"], datestamp: 100 }),
      makeGame({ gameId: "f2", color: "white", ucis: ["d2d4", "g8f6"], datestamp: 101 }),
    ];
    const reentry = computeFuturePrefixReentry(future, x.ucis);
    expect(reentry.futurePrefixEntryCount).toBe(1);
    expect(reentry.futurePrefixEntryRate).toBe(0.5);
    expect(reentry.futurePrefixEntryBinary).toBe(1);
  });
});

describe("grounded X inventory", () => {
  it("never marks n=1 as phase0 S1 but qualifies n>=2 with >=2 dates", () => {
    const singletonTrain = [
      makeGame({ gameId: "n1", color: "white", ucis: ["e2e4", "c7c5", "g1f3"], datestamp: 1_700_000_000_000 }),
    ];
    const single = inventoryGroundedX(singletonTrain, "white");
    expect(single.phase0S1Eligible).toBe(false);
    expect(single.repeatSupported).toBe(false);
    expect(single.singletonDiagnostic).toBe(true);

    const repeatTrain = [
      makeGame({ gameId: "r1", color: "white", ucis: ["e2e4", "c7c5", "g1f3", "d7d6"], datestamp: 1_700_000_000_000 }),
      makeGame({ gameId: "r2", color: "white", ucis: ["e2e4", "c7c5", "g1f3", "d7d6"], datestamp: 1_700_086_400_000 }),
      makeGame({ gameId: "r3", color: "white", ucis: ["e2e4", "c7c5", "g1f3", "b8c6"], datestamp: 1_700_172_800_000 }),
    ];
    const repeat = inventoryGroundedX(repeatTrain, "white");
    expect(repeat.phase0S1Eligible).toBe(true);
    expect(repeat.repeatSupported).toBe(true);
    expect(repeat.distinctGames).toBeGreaterThanOrEqual(2);
    expect(repeat.distinctDates).toBeGreaterThanOrEqual(2);
  });
});

describe("phase0 gates and verdict branches", () => {
  const protocol = loadProtocol();

  it("assigns depth bins on usable units", () => {
    const playerGames = synthPanelPlayers(2, 40);
    const report = runPhase0Inventory({ protocol, playerGames });
    const usable = report.units.filter((u) => u.v2X.v2XUsable);
    for (const u of usable) {
      expect(["2-4", "5-8", "9-12"]).toContain(u.v2X.depthBin);
    }
  });

  it("flags all-zero future-entry binary degeneracy with band gate failure", () => {
    const playerGames = synthRecurrencePanel(20, 40, { futureMatchesTrain: false });
    const report = runPhase0Inventory({ protocol, playerGames });
    const usable = report.units.filter((u) => u.v2X.v2XUsable);
    expect(usable.length).toBeGreaterThan(0);
    expect(usable.every((u) => u.v2X.futurePrefixEntryBinary === 0)).toBe(true);
    expect(report.panel.allZeroFutureEntryBinary).toBe(true);
    expect(report.panel.allOneFutureEntryBinary).toBe(false);
    expect(report.panel.v2FutureEntryBinaryRate).toBe(0);
    expect(report.panel.gateResults.v2FutureEntryBinaryRateInBand).toBe(false);
    expect(report.verdict).toBe(RY_VERDICTS.PHASE0_INSUFFICIENT_INVENTORY);
  });

  it("flags all-one future-entry binary degeneracy with band gate failure", () => {
    const playerGames = synthRecurrencePanel(20, 40, { futureMatchesTrain: true });
    const report = runPhase0Inventory({ protocol, playerGames });
    const usable = report.units.filter((u) => u.v2X.v2XUsable);
    expect(usable.length).toBeGreaterThan(0);
    expect(usable.every((u) => u.v2X.futurePrefixEntryBinary === 1)).toBe(true);
    expect(report.panel.allOneFutureEntryBinary).toBe(true);
    expect(report.panel.allZeroFutureEntryBinary).toBe(false);
    expect(report.panel.v2FutureEntryBinaryRate).toBe(1);
    expect(report.panel.gateResults.v2FutureEntryBinaryRateInBand).toBe(false);
    expect(report.verdict).toBe(RY_VERDICTS.PHASE0_INSUFFICIENT_INVENTORY);
  });

  it("passes PHASE0_RUNNABLE on a synthetic panel with enough support", () => {
    const playerGames = synthPanelPlayers(12, 80);
    const report = runPhase0Inventory({ protocol, playerGames });
    expect(report.verdict).toBe(RY_VERDICTS.PHASE0_RUNNABLE);
    expect(report.panel.gateResults.minTotalUsableUnits).toBe(true);
    expect(report.panel.gateResults.minRepeatSupportedUnits).toBe(true);
    expect(report.panel.gateResults.medianFutureGamesExact).toBe(true);
    expect(report.productAuthorization).toBe(false);
    expect(report.cannotAuthorizeEnginePhase).toBe(true);
  });

  it("returns PHASE0_INSUFFICIENT_INVENTORY when gates fail", () => {
    const playerGames = synthPanelPlayers(2, 35);
    const report = runPhase0Inventory({ protocol, playerGames });
    expect(report.verdict).toBe(RY_VERDICTS.PHASE0_INSUFFICIENT_INVENTORY);
  });

  it("returns INVALID for broken protocol at runtime", () => {
    const bad = { ...loadProtocol(), kind: "wrong" };
    const report = runPhase0Inventory({ protocol: bad, playerGames: [] });
    expect(report.verdict).toBe(RY_VERDICTS.INVALID);
  });
});

describe("JSON null strictness and report hash", () => {
  it("uses null abstention fields and stable scientific payload hash", () => {
    const protocol = loadProtocol();
    const report = runPhase0Inventory({ protocol, playerGames: synthPanelPlayers(3, 40) });
    const noX = report.units.find((u) => u.v2X.abstentionReason != null);
    if (noX) expect(noX.v2X.ucis).toBeNull();

    const clone = JSON.parse(JSON.stringify(report));
    delete clone.reportSha256;
    const h1 = computeScientificPayloadSha256(report);
    const h2 = computeScientificPayloadSha256(clone);
    expect(h1).toBe(h2);
    expect(computeRobustYReportSha256(report)).toBe(report.reportSha256);
  });
});

function buildVerifiedFixture({ tamperReport = null, tamperArtifact = null, snapshotSha = "abc" } = {}) {
  const protocol = loadProtocol();
  const playerGames = synthPanelPlayers(12, 80);
  const manifest = buildRobustYManifest({
    protocol,
    protocolSha256: snapshotSha,
    cohortRoot: protocol.inputs.cohortRoot,
    players: playerGames.map((p) => ({
      playerId: p.playerId,
      gamesPath: `tmp/${p.playerId}.json`,
      gamesSha256: "g",
      dumpPath: `tmp/${p.playerId}-bias.ndjson`,
      dumpSha256: "d",
      gameCount: p.games.length,
    })),
  });
  const manifestSha256 = computeManifestSha256(manifest);
  const report = runPhase0Inventory({
    protocol,
    protocolSha256: snapshotSha,
    manifest,
    manifestSha256,
    playerGames,
  });
  const unitArtifacts = JSON.parse(JSON.stringify(report.units));
  if (tamperArtifact) tamperArtifact(unitArtifacts[0]);
  const finalReport = tamperReport ? tamperReport(report) : report;
  const phase0StartedRecord = {
    startedAt: "2026-01-01T00:00:00.000Z",
    protocolSha256: snapshotSha,
    manifestSha256,
    stateSeq: 1,
  };
  const events = [
    {
      seq: 1,
      type: "freeze",
      protocolSha256: snapshotSha,
      manifestSha256,
      playersSha256: manifest.playersSha256,
    },
    {
      seq: 2,
      type: "phase0",
      verdict: finalReport.verdict,
      reportSha256: finalReport.reportSha256,
      manifestSha256,
      scientificPayloadSha256: computeScientificPayloadSha256(finalReport),
      productAuthorization: false,
    },
  ];
  const stateRecord = {
    state: RY_STATES.PHASE0_COMPLETE,
    seq: 2,
    protocolSha256: snapshotSha,
    manifestSha256,
    cohortRoot: protocol.inputs.cohortRoot,
    playersSha256: manifest.playersSha256,
    verdict: finalReport.verdict,
    reportSha256: finalReport.reportSha256,
    scientificPayloadSha256: computeScientificPayloadSha256(finalReport),
  };
  return {
    protocol,
    manifest,
    manifestSha256,
    phase0StartedRecord,
    report: finalReport,
    unitArtifacts,
    events,
    stateRecord,
    recomputedReport: runPhase0Inventory({
      protocol,
      protocolSha256: snapshotSha,
      manifest,
      manifestSha256,
      playerGames,
    }),
    snapshotSha,
  };
}

describe("lifecycle integrity", () => {
  const protocol = loadProtocol();

  it("enforces state transitions and burn markers", () => {
    expect(() => assertRyStateTransition(RY_STATES.FROZEN, RY_STATES.UNINITIALIZED)).toThrow();
    assertRyStateTransition(RY_STATES.FROZEN, RY_STATES.PHASE0_COMPLETE);
    const markers = listPhase0BurnMarkers("/study", {
      exists: (p) => p.endsWith("phase0-started.json"),
      state: { state: RY_STATES.PHASE0_COMPLETE },
      events: [{ type: "phase0" }],
    });
    expect(markers.length).toBeGreaterThan(0);
    expect(() => refuseIfPhase0Burned("/study", {
      exists: (p) => p.endsWith("phase0-started.json"),
      state: { state: RY_STATES.FROZEN },
      events: [],
    })).toThrow(/burned/);
  });

  it("detects stuck phase0-started-without-report", () => {
    const stuck = describePhase0StuckState("/study", {
      exists: (p) => p.endsWith("phase0-started.json"),
      state: { state: RY_STATES.FROZEN },
      events: [],
    });
    expect(stuck.stuck).toBe(true);
    expect(stuck.reason).toBe("phase0-started-without-report");
  });

  it("anchors snapshot hash against state and freeze event, not itself", () => {
    const fx = buildVerifiedFixture();
    const good = verifyRobustYStudy({
      state: RY_STATES.PHASE0_COMPLETE,
      protocol: fx.protocol,
      protocolSha256: fx.snapshotSha,
      snapshotProtocolSha256: fx.snapshotSha,
      manifest: fx.manifest,
      rawManifestSha256: fx.manifestSha256,
      phase0StartedRecord: fx.phase0StartedRecord,
      report: fx.report,
      events: fx.events,
      unitArtifacts: fx.unitArtifacts,
      stateRecord: fx.stateRecord,
      recomputedReport: fx.recomputedReport,
    });
    expect(good.ok).toBe(true);

    const drifted = verifyRobustYStudy({
      state: RY_STATES.PHASE0_COMPLETE,
      protocol: fx.protocol,
      protocolSha256: fx.snapshotSha,
      snapshotProtocolSha256: "stale-snapshot-sha",
      manifest: fx.manifest,
      rawManifestSha256: fx.manifestSha256,
      phase0StartedRecord: fx.phase0StartedRecord,
      report: fx.report,
      events: fx.events,
      unitArtifacts: fx.unitArtifacts,
      stateRecord: fx.stateRecord,
      recomputedReport: fx.recomputedReport,
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.issues.some((i) => i.kind === "state-snapshot-protocol-sha-mismatch")).toBe(true);
  });

  it("rejects tampered report, artifact, and coordinated tamper via recompute", () => {
    const fx = buildVerifiedFixture({
      tamperReport: (r) => ({ ...r, productAuthorization: true }),
    });
    const badReport = verifyRobustYStudy({
      state: RY_STATES.PHASE0_COMPLETE,
      protocol: fx.protocol,
      protocolSha256: fx.snapshotSha,
      snapshotProtocolSha256: fx.snapshotSha,
      manifest: fx.manifest,
      rawManifestSha256: fx.manifestSha256,
      phase0StartedRecord: fx.phase0StartedRecord,
      report: fx.report,
      events: fx.events,
      unitArtifacts: fx.unitArtifacts,
      stateRecord: fx.stateRecord,
      recomputedReport: fx.recomputedReport,
    });
    expect(badReport.ok).toBe(false);

    const fx2 = buildVerifiedFixture({
      tamperArtifact: (artifact) => {
        artifact.v2X.trainPrefixSupport = 999;
      },
    });
    const badArtifact = verifyRobustYStudy({
      state: RY_STATES.PHASE0_COMPLETE,
      protocol: fx2.protocol,
      protocolSha256: fx2.snapshotSha,
      snapshotProtocolSha256: fx2.snapshotSha,
      manifest: fx2.manifest,
      rawManifestSha256: fx2.manifestSha256,
      phase0StartedRecord: fx2.phase0StartedRecord,
      report: fx2.report,
      events: fx2.events,
      unitArtifacts: fx2.unitArtifacts,
      stateRecord: fx2.stateRecord,
      recomputedReport: fx2.recomputedReport,
    });
    expect(badArtifact.ok).toBe(false);
    expect(badArtifact.issues.some((i) => i.kind === "unit-artifact-report-hash-mismatch")).toBe(true);
    expect(badArtifact.issues.some((i) => i.kind === "recomputed-unit-hash-mismatch")).toBe(false);
  });

  it("requires bijective per-unit artifacts with full content hash equality", () => {
    const fx = buildVerifiedFixture();
    for (const unit of fx.report.units) {
      const artifact = fx.unitArtifacts.find((a) => a.unitId === unit.unitId);
      expect(computeUnitContentHash(artifact)).toBe(computeUnitContentHash(unit));
    }
    const dupArtifacts = [...fx.unitArtifacts, { ...fx.unitArtifacts[0] }];
    const dup = verifyRobustYStudy({
      state: RY_STATES.PHASE0_COMPLETE,
      protocol: fx.protocol,
      protocolSha256: fx.snapshotSha,
      snapshotProtocolSha256: fx.snapshotSha,
      manifest: fx.manifest,
      rawManifestSha256: fx.manifestSha256,
      phase0StartedRecord: fx.phase0StartedRecord,
      report: fx.report,
      events: fx.events,
      unitArtifacts: dupArtifacts,
      stateRecord: fx.stateRecord,
      recomputedReport: fx.recomputedReport,
    });
    expect(dup.ok).toBe(false);
    expect(dup.issues.some((i) => i.kind === "per-unit-artifact-count-mismatch")).toBe(true);
  });

  it("checks artifact presence with real unit count", () => {
    const fx = buildVerifiedFixture();
    const presence = checkRobustYArtifactPresence({
      state: RY_STATES.PHASE0_COMPLETE,
      hasProtocolSnapshot: true,
      hasManifest: true,
      hasReport: true,
      hasSummary: true,
      hasPhase0Started: true,
      unitArtifacts: fx.unitArtifacts,
      expectedUnitCount: fx.report.units.length,
    });
    expect(presence.ok).toBe(true);
  });

  it("validates pretty-bytes manifestSha256 convention end-to-end", () => {
    const fx = buildVerifiedFixture();
    const prettyBytes = manifestBytesForHash(fx.manifest);
    expect(fx.manifestSha256).toBe(computeManifestSha256(fx.manifest));
    expect(fx.report.manifestSha256).toBe(fx.manifestSha256);
    expect(fx.stateRecord.manifestSha256).toBe(fx.manifestSha256);
    expect(fx.events[0].manifestSha256).toBe(fx.manifestSha256);
    expect(fx.events[1].manifestSha256).toBe(fx.manifestSha256);
    expect(fx.phase0StartedRecord.manifestSha256).toBe(fx.manifestSha256);
    expect(prettyBytes.endsWith("\n")).toBe(true);
    expect(fx.recomputedReport.manifestSha256).toBe(fx.manifestSha256);
  });

  it("rejects metadata-only manifest mutation when freeze pin stays old", () => {
    const fx = buildVerifiedFixture();
    const mutatedManifest = { ...fx.manifest, createdAt: "2099-01-01T00:00:00.000Z" };
    const mutatedSha = computeManifestSha256(mutatedManifest);
    expect(mutatedSha).not.toBe(fx.manifestSha256);

    const coordinatedReport = runPhase0Inventory({
      protocol: fx.protocol,
      protocolSha256: fx.snapshotSha,
      manifest: mutatedManifest,
      manifestSha256: mutatedSha,
      playerGames: synthPanelPlayers(12, 80),
    });
    const coordinatedState = {
      ...fx.stateRecord,
      manifestSha256: mutatedSha,
      reportSha256: coordinatedReport.reportSha256,
      scientificPayloadSha256: computeScientificPayloadSha256(coordinatedReport),
    };
    const coordinatedEvents = [
      fx.events[0],
      {
        ...fx.events[1],
        reportSha256: coordinatedReport.reportSha256,
        manifestSha256: mutatedSha,
        scientificPayloadSha256: computeScientificPayloadSha256(coordinatedReport),
      },
    ];
    const stillPinned = verifyRobustYStudy({
      state: RY_STATES.PHASE0_COMPLETE,
      protocol: fx.protocol,
      protocolSha256: fx.snapshotSha,
      snapshotProtocolSha256: fx.snapshotSha,
      manifest: mutatedManifest,
      rawManifestSha256: mutatedSha,
      phase0StartedRecord: { ...fx.phase0StartedRecord, manifestSha256: mutatedSha },
      report: coordinatedReport,
      events: coordinatedEvents,
      unitArtifacts: coordinatedReport.units,
      stateRecord: coordinatedState,
      recomputedReport: coordinatedReport,
    });
    expect(stillPinned.ok).toBe(false);
    expect(stillPinned.issues.some((i) => i.kind === "freeze-event-manifest-sha-mismatch")).toBe(true);
  });

  it("rejects event sequence corruption", () => {
    const fx = buildVerifiedFixture();
    const corrupt = verifyRobustYStudy({
      state: RY_STATES.PHASE0_COMPLETE,
      protocol: fx.protocol,
      protocolSha256: fx.snapshotSha,
      snapshotProtocolSha256: fx.snapshotSha,
      manifest: fx.manifest,
      rawManifestSha256: fx.manifestSha256,
      phase0StartedRecord: fx.phase0StartedRecord,
      report: fx.report,
      events: [
        { seq: 2, type: "freeze", protocolSha256: fx.snapshotSha, manifestSha256: fx.manifestSha256, playersSha256: fx.manifest.playersSha256 },
        { seq: 2, type: "phase0", reportSha256: fx.report.reportSha256, manifestSha256: fx.manifestSha256, productAuthorization: false },
      ],
      unitArtifacts: fx.unitArtifacts,
      stateRecord: fx.stateRecord,
      recomputedReport: fx.recomputedReport,
    });
    expect(corrupt.ok).toBe(false);
    expect(corrupt.issues.some((i) => i.kind === "event-seq-not-increasing")).toBe(true);
  });
});

describe("synthetic end-to-end phase0 inventory", () => {
  it("builds summary and unit-level diagnostics", () => {
    const protocol = loadProtocol();
    const playerGames = synthPanelPlayers(12, 80);
    const report = runPhase0Inventory({ protocol, playerGames });
    const summary = buildRobustYSummary(report);
    expect(summary).toContain("Robust-Y Phase-0");
    expect(summary).toContain(report.verdict);
    expect(report.units.length).toBeGreaterThanOrEqual(40);
    expect(report.panel.abstentionReasons).toBeTruthy();
    expect(report.futureP1DocumentedOnly).toBe(true);
  });

  it("evaluates one unit with train/future split integrity", () => {
    const games = synthOpeningGames("unit-player", 50);
    const sorted = sortGamesChronologically(games.filter((g) => g.color === "white"));
    const { train, future, cutoff } = splitTrainFuture(sorted, 30);
    const unit = evaluatePhase0Unit({
      playerId: "unit-player",
      subjectColor: "white",
      window: {
        cutoff,
        trainGames: train,
        futureGames: future,
        trainFutureOverlap: [],
        leakageFree: true,
      },
      protocol: loadProtocol(),
    });
    expect(unit.trainGameCount).toBe(30);
    expect(unit.futureGameCount).toBe(10);
    expect(unit.leakageFree).toBe(true);
    expect(unit.v2X.source).toBe(RY_V2_X_SOURCE);
  });
});

describe("optional real cohort shape", () => {
  it("discovers pair filenames when cohort exists", () => {
    if (!existsSync(COHORT_ROOT)) return;
    const names = readdirSync(COHORT_ROOT);
    const pairs = discoverCohortPairs(names.map((name) => ({ name })));
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((p) => p.playerId && p.gamesFile && p.dumpFile)).toBe(true);
  });
});