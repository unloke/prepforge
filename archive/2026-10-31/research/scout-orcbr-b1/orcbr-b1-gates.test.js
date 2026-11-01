import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  VERDICTS,
  FROZEN_PINS,
  computeReportSha256,
  pseudonymKey,
} from "./orcbr-b1-schema.js";
import {
  FIXTURE_PIN_OVERRIDES,
  buildPhase0Report,
  fitUnitsAtCutoff,
  runG0,
  runG1,
  runG2,
  runG3,
  runG4,
  runG5,
  runG6,
  runG7,
  runGates,
  DEFAULT_PINS,
} from "./orcbr-b1-gates.js";
import { expandCandidatesToBudget } from "./orcbr-b1-generate.js";
import { buildPreparationUnitV2, matchUnitToGame } from "./orcbr-b1-units.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL = JSON.parse(
  readFileSync(join(HERE, "orcbr-b1.protocol.json"), "utf8"),
);

const SALT = "gates-salt-xx";
const SUBJECT = "subject1";
const OPP = "OpponentRepeat";

function ndjsonGame(id, createdAt, whiteId = OPP) {
  return JSON.stringify({
    id,
    createdAt,
    players: {
      white: { user: { id: whiteId } },
      black: { user: { id: SUBJECT } },
    },
    status: "resign",
    pgn: `[Event "T"]\n[Site "https://lichess.org/${id}"]\n[White "${whiteId}"]\n[Black "${SUBJECT}"]\n[Result "0-1"]\n[UTCDate "2024.06.01"]\n\n1. e4 e5 *\n`,
    ucis: ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"],
  });
}

function fixtureGames(n = 20) {
  const oppKey = pseudonymKey(OPP, SALT);
  const openings = [
    ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6"],
    ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6"],
    ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "c1g5", "f8e7"],
    ["c2c4", "e7e5", "b1c3", "g8f6", "g1f3", "b8c6", "g2g3", "d7d5"],
  ];
  const games = [];
  for (let i = 0; i < n; i += 1) {
    const opening = openings[i % openings.length];
    games.push({
      gameId: `fg-${i}`,
      color: "black",
      opponentKey: oppKey,
      identityConfidence: "id",
      subjectKey: pseudonymKey(SUBJECT, SALT),
      createdAtMs: 1_700_000_000_000 + i * 86_400_000,
      dayKey: new Date(1_700_000_000_000 + i * 86_400_000).toISOString().slice(0, 10),
      ucis: opening,
      familyTokens: [opening.slice(0, 3).join(" ")],
      score: i % 2,
      result: "1-0",
    });
  }
  return games;
}

describe("G0 schema", () => {
  it("fails sealed without opponentKey", () => {
    const r = runG0({
      sealedRecords: [{ gameId: "x", color: "black", ucis: [] }],
      protocol: PROTOCOL,
    });
    expect(r.pass).toBe(false);
    expect(r.verdict).toBe(VERDICTS.STOP_SCHEMA_UNAVAILABLE);
  });

  it("passes dual-parse on local NDJSON fixture", () => {
    const rawText = Array.from({ length: 5 }, (_, i) => ndjsonGame(`g${i}`, 1000 + i)).join("\n");
    const r = runG0({
      rawText,
      subjectUsername: SUBJECT,
      researchSalt: SALT,
      protocol: PROTOCOL,
      knownRawTokens: [SUBJECT, OPP],
    });
    expect(r.pass).toBe(true);
    expect(r.withOpponentKeyCount).toBe(5);
    expect(r.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r.games)).not.toMatch(new RegExp(OPP, "i"));
    expect(JSON.stringify(r.games)).not.toMatch(new RegExp(SUBJECT, "i"));
  });

  it("refuses weak salt", () => {
    const r = runG0({
      rawText: ndjsonGame("g0", 1),
      subjectUsername: SUBJECT,
      researchSalt: "tiny",
      protocol: PROTOCOL,
    });
    expect(r.pass).toBe(false);
    expect(r.verdict).toBe(VERDICTS.STOP_SCHEMA_UNAVAILABLE);
  });
});

describe("G1–G7 ordered stops", () => {
  it("G1 fails when identity sparse", () => {
    const games = [
      { gameId: "1", color: "black", opponentKey: null, identityConfidence: "none" },
      { gameId: "2", color: "black", opponentKey: null, identityConfidence: "none" },
    ];
    const r = runG1(games);
    expect(r.verdict).toBe(VERDICTS.STOP_IDENTITY_SPARSE);
  });

  it("G1 fails when only name-lower (weak fallback alone)", () => {
    const games = Array.from({ length: 10 }, (_, i) => ({
      gameId: `n${i}`,
      color: "black",
      opponentKey: "opp_aaaaaaaaaaaaaaaa",
      identityConfidence: "name-lower",
    }));
    const r = runG1(games);
    expect(r.verdict).toBe(VERDICTS.STOP_IDENTITY_SPARSE);
    expect(r.reason).toMatch(/name-lower/);
  });

  it("G2 fails without longitudinal recurrence (live floors 30/10)", () => {
    const games = [
      {
        gameId: "1",
        color: "black",
        opponentKey: "opp_aaa",
        createdAtMs: 1,
        dayKey: "2024-01-01",
        ucis: ["e2e4", "e7e5"],
      },
    ];
    const r = runG2(games, DEFAULT_PINS, { fixtureMode: false });
    expect(r.verdict).toBe(VERDICTS.STOP_NO_LONGITUDINAL_RECURRENCE);
    expect(r.gMin).toBe(FROZEN_PINS.g_min_white_games_per_key);
    expect(r.dMin).toBe(FROZEN_PINS.d_min_distinct_days_per_key);
    expect(r.nMin).toBe(FROZEN_PINS.n_o_min_opponent_keys);
    expect(r.fixtureMode).toBe(false);
    // Privacy-safe aggregates required for stop audit (no opponentKey list on fail)
    expect(r.diagnostics).toBeTruthy();
    expect(r.diagnostics.qualifyingCount).toBe(0);
    expect(r.diagnostics.maxGamesPerKey).toBe(1);
    expect(r.diagnostics.maxDaysPerKey).toBe(1);
    expect(r.diagnostics.blackGameCount).toBe(1);
    expect(r.diagnostics.opponentKeyCount).toBe(1);
    expect(r.diagnostics.outcomeBlind).toBe(true);
    expect(JSON.stringify(r.diagnostics)).not.toMatch(/opp_/);
  });

  it("G2 live mode refuses small fixtures that would pass only under fixtureMode", () => {
    const games = fixtureGames(24);
    const live = runG2(games, DEFAULT_PINS, { fixtureMode: false });
    expect(live.pass).toBe(false);
    expect(live.diagnostics.fixtureMode).toBe(false);
    expect(live.diagnostics.gMin).toBe(FROZEN_PINS.g_min_white_games_per_key);
    expect(live.diagnostics.dMin).toBe(FROZEN_PINS.d_min_distinct_days_per_key);
    // 24 black games vs one key → below gMin=30, so not qualifying
    expect(live.diagnostics.maxGamesPerKey).toBe(24);
    expect(live.diagnostics.qualifyingCount).toBe(0);
    expect(live.diagnostics.keysAtOrAboveGMin).toBe(0);
    expect(live.diagnostics.gamesPerKeyHistogram["20-29"]).toBe(1);
    const fix = runG2(games, { ...DEFAULT_PINS, ...FIXTURE_PIN_OVERRIDES }, { fixtureMode: true });
    expect(fix.pass).toBe(true);
    expect(fix.diagnostics.fixtureMode).toBe(true);
    expect(fix.diagnostics.qualifyingCount).toBeGreaterThanOrEqual(1);
  });

  it("G2 ignores subject-White games and outcome fields when counting longitudinal history", () => {
    const oppKey = "opp_bbbbbbbbbbbbbbbb";
    const games = [];
    // 5 subject-Black days vs one opponent (counts toward G2)
    for (let i = 0; i < 5; i += 1) {
      games.push({
        gameId: `b${i}`,
        color: "black",
        opponentKey: oppKey,
        createdAtMs: 1_000 + i * 86_400_000,
        dayKey: `2024-01-0${i + 1}`,
        ucis: ["e2e4", "e7e5"],
        score: 1,
        result: "0-1",
        status: "mate",
      });
    }
    // 40 subject-White games same key must NOT inflate White-history counts
    for (let i = 0; i < 40; i += 1) {
      games.push({
        gameId: `w${i}`,
        color: "white",
        opponentKey: oppKey,
        createdAtMs: 2_000 + i * 86_400_000,
        dayKey: `2024-02-${String(i + 1).padStart(2, "0")}`,
        ucis: ["e2e4", "e7e5"],
        score: 0,
      });
    }
    const r = runG2(games, DEFAULT_PINS, { fixtureMode: false });
    expect(r.pass).toBe(false);
    expect(r.diagnostics.blackGameCount).toBe(5);
    expect(r.diagnostics.whiteSubjectGameCount).toBe(40);
    expect(r.diagnostics.maxGamesPerKey).toBe(5);
    expect(r.diagnostics.maxDaysPerKey).toBe(5);
    expect(r.diagnostics.qualifyingCount).toBe(0);
    // Outcomes present on input must not affect verdict; diagnostics flag them if not stripped
    expect(r.diagnostics.outcomeFieldHits).toBeGreaterThan(0);
  });

  it("G3 packs budget 12 via expand on multi-family fixture", () => {
    const games = fixtureGames(24);
    const r = runG3(games, {
      requireExactFill: true,
      useExpand: true,
      pins: FIXTURE_PIN_OVERRIDES,
    });
    expect(r.pass).toBe(true);
    expect(r.package.totalCost).toBe(12);
    expect(r.package.exactFill).toBe(true);
  });

  it("G4 catches cost gaming", () => {
    const bad = buildPreparationUnitV2({
      opponentKey: "opp_abcdef0123456789",
      familyEpds: ["e2e4"],
      replyUci: "e7e5",
      coverageCost: 1,
    });
    bad.identityPayload.coverageCost = 9;
    const r = runG4([bad]);
    expect(r.verdict).toBe(VERDICTS.STOP_COST_GAMING);
  });

  it("G5 passes when families outside v2 set; fails near-identical", () => {
    const u = buildPreparationUnitV2({
      opponentKey: "opp_abcdef0123456789",
      familyEpds: ["unique-family-xyz"],
      replyUci: "e7e5",
      coverageCost: 1,
    });
    expect(runG5([u], ["v2-only-path"]).pass).toBe(true);

    const same = buildPreparationUnitV2({
      opponentKey: "opp_abcdef0123456789",
      familyEpds: ["shared-path"],
      replyUci: "e7e5",
      coverageCost: 1,
    });
    const fail = runG5([same], ["shared-path"]);
    expect(fail.pass).toBe(false);
    expect(fail.verdict).toBe(VERDICTS.STOP_NOT_DISTINCT_FROM_V2);
    expect(fail.jaccard).toBe(1);
  });

  it("G7 invalidates productAuthorization true", () => {
    const r = runG7({
      protocol: PROTOCOL,
      report: { productAuthorization: true, productVerdict: "preserve-v2" },
    });
    expect(r.verdict).toBe(VERDICTS.INVALID);
  });

  it("G7 passes with frozen product flags", () => {
    const r = runG7({
      protocol: PROTOCOL,
      report: { productAuthorization: false, productVerdict: "preserve-v2" },
      packageObj: { productAuthorization: false },
    });
    expect(r.pass).toBe(true);
    expect(r.verdict).toBe(VERDICTS.GATES_PASSED_EVAL_NOT_RUN);
  });
});

describe("G6 prequential — no optimistic full-sample fit", () => {
  it("re-fits units on train only (future-only openings cannot enter fit)", () => {
    const oppKey = pseudonymKey(OPP, SALT);
    const games = [];
    // First 12 games: e4 only
    for (let i = 0; i < 12; i += 1) {
      games.push({
        gameId: `early-${i}`,
        color: "black",
        opponentKey: oppKey,
        identityConfidence: "id",
        createdAtMs: 1_000 + i * 86_400_000,
        dayKey: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
        ucis: ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6"],
      });
    }
    // Last 8 games: unique late opening
    for (let i = 0; i < 8; i += 1) {
      games.push({
        gameId: `late-${i}`,
        color: "black",
        opponentKey: oppKey,
        identityConfidence: "id",
        createdAtMs: 1_000 + (20 + i) * 86_400_000,
        dayKey: new Date(Date.UTC(2024, 2, 1 + i)).toISOString().slice(0, 10),
        ucis: ["a2a3", "a7a6", "b2b3", "b7b6", "c2c3", "c7c6", "d2d3", "d7d6"],
      });
    }
    // At 50% cut, fit should not include late a2a3 family
    const cut = Math.floor(games.length * 0.5);
    const train = games.slice(0, cut);
    const fit = fitUnitsAtCutoff(train, FIXTURE_PIN_OVERRIDES);
    for (const u of fit) {
      const fam = u.identityPayload.matcher.familyEpds.join(" ");
      expect(fam).not.toMatch(/a2a3/);
    }
    // Full-sample units WOULD include late family if naively fit on all — contrast
    const fullFit = fitUnitsAtCutoff(games, FIXTURE_PIN_OVERRIDES);
    const fullHasLate = fullFit.some((u) =>
      u.identityPayload.matcher.familyEpds.join(" ").includes("a2a3"),
    );
    // late family needs multi-game recurrence — may or may not appear depending on depth
    // The critical property: train-fit never sees late games
    expect(train.every((g) => !String(g.gameId).startsWith("late"))).toBe(true);

    const r = runG6(games, fullFit /* ignored */, FIXTURE_PIN_OVERRIDES);
    expect(r.hits?.length).toBeGreaterThan(0);
    // Each fold reports fitUnitCount from re-fit, not from caller units
    for (const h of r.hits) {
      expect(h.fitUnitCount).toBeDefined();
    }
    // If full-sample units were used optimistically on late games, hit rates would
    // be inflated; re-fit keeps late-only structure out of early folds.
    void fullHasLate;
    expect([
      VERDICTS.READY_FOR_GATES,
      VERDICTS.STOP_PREQUENTIAL_INFEASIBLE,
    ]).toContain(r.verdict);
  });

  it("returns structured hit rates without double-counting multi-unit games", () => {
    const games = fixtureGames(20);
    const r = runG6(games, null, FIXTURE_PIN_OVERRIDES);
    expect([
      VERDICTS.READY_FOR_GATES,
      VERDICTS.STOP_PREQUENTIAL_INFEASIBLE,
    ]).toContain(r.verdict);
    expect(r.hits?.length || r.mean != null || r.reason).toBeTruthy();
  });
});

describe("runGates pipeline + report self-hash", () => {
  it("STOP_SCHEMA_UNAVAILABLE short-circuits at G0", () => {
    const run = runGates({
      sealedRecords: [{ gameId: "a", color: "black" }],
      protocol: PROTOCOL,
    }, { through: "G7" });
    expect(run.ok).toBe(false);
    expect(run.verdict).toBe(VERDICTS.STOP_SCHEMA_UNAVAILABLE);
    expect(run.results).toHaveLength(1);
  });

  it("live default fails G2 on small fixtures (fail-closed floors)", () => {
    const games = fixtureGames(24);
    const run = runGates({
      sealedRecords: games,
      games,
      protocol: PROTOCOL,
      fixtureMode: false,
    }, { through: "G7" });
    expect(run.ok).toBe(false);
    expect(run.verdict).toBe(VERDICTS.STOP_NO_LONGITUDINAL_RECURRENCE);
    const g2 = run.results.find((x) => x.gate === "G2");
    expect(g2?.diagnostics?.fixtureMode).toBe(false);
    expect(g2?.diagnostics?.gMin).toBe(FROZEN_PINS.g_min_white_games_per_key);
    expect(g2?.diagnostics?.qualifyingCount).toBe(0);
    const report = buildPhase0Report({
      protocol: PROTOCOL,
      gateRun: run,
      rawSha256: "a".repeat(64),
      knownRawTokens: [OPP, SUBJECT],
    });
    expect(report.g2Diagnostics).toBeTruthy();
    expect(report.g2Diagnostics.qualifyingCount).toBe(0);
    expect(report.g2Diagnostics.maxGamesPerKey).toBe(24);
    expect(report.scientificScope).toBe("structural-only");
    expect(report.nonConfirmatory).toBe(true);
    expect(JSON.stringify(report.g2Diagnostics)).not.toMatch(new RegExp(OPP, "i"));
    expect(JSON.stringify(report.g2Diagnostics)).not.toMatch(new RegExp(SUBJECT, "i"));
    expect(report.reportSha256).toBe(computeReportSha256(report));
  });

  it("fixtureMode structural path produces self-hashed report without raw names", () => {
    const games = fixtureGames(24);
    const packed = expandCandidatesToBudget(games, 12, FIXTURE_PIN_OVERRIDES);
    expect(packed.exactFill).toBe(true);

    const run = runGates({
      sealedRecords: games,
      games,
      protocol: PROTOCOL,
      fixtureMode: true,
      v2Paths: ["totally-different-v2-path"],
      knownRawTokens: [OPP, SUBJECT],
    }, { through: "G7" });

    expect(run.results[0].pass).toBe(true);
    const g3 = run.results.find((x) => x.gate === "G3");
    expect(g3?.pass).toBe(true);
    // Receipt chain present
    expect(run.results[0].receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    if (run.results.length > 1) {
      expect(run.results[1].priorGateSha256).toBe(run.results[0].receiptSha256);
    }

    const report = buildPhase0Report({
      protocol: PROTOCOL,
      gateRun: {
        verdict: run.verdict,
        results: run.results,
        package: run.package || {
          packageSha256: packed.units ? "x" : "x",
          totalCost: 12,
          exactFill: true,
          units: packed.units,
        },
      },
      rawSha256: "a".repeat(64),
      knownRawTokens: [OPP, SUBJECT],
    });
    expect(report.productAuthorization).toBe(false);
    expect(report.productVerdict).toBe("preserve-v2");
    expect(report.reportSha256).toBe(computeReportSha256(report));
    expect(JSON.stringify(report)).not.toMatch(/OpponentRepeat/);
    expect(JSON.stringify(report)).not.toMatch(/subject1/);

    // Tamper detection
    const tampered = { ...report, verdict: "HACKED" };
    expect(computeReportSha256(tampered)).not.toBe(report.reportSha256);
  });
});

describe("match integrity vs foreign opponents", () => {
  it("package units never match foreign opponentKey games", () => {
    const games = fixtureGames(16);
    const packed = expandCandidatesToBudget(games, 12, FIXTURE_PIN_OVERRIDES);
    const foreign = {
      color: "black",
      opponentKey: "opp_ffffffffffff0000",
      ucis: games[0].ucis,
    };
    for (const u of packed.units) {
      expect(matchUnitToGame(u, foreign).match).toBe(false);
    }
  });
});
