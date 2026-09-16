import { describe, expect, it } from "vitest";

import {
  ORCBR_UNIT_CONTRACT_EXACT_V1,
  ORCBR_UNIT_CONTRACT_V2,
} from "./orcbr-b1-schema.js";
import {
  PACKAGE_SLOT_BUDGET,
  buildPreparationUnitV2,
  inferMinCoverageCost,
  matchUnitToGame,
  packUnitsToBudget,
  packageContentHash,
  rankUnits,
  slotNormalizedCoverage,
  validateExactAtomV1,
  validateForGeneralizedScorer,
  validatePackage,
  validatePreparationUnitV2,
} from "./orcbr-b1-units.js";

const OPP = "opp_abcdef0123456789";

function makeUnit(overrides = {}) {
  return buildPreparationUnitV2({
    opponentKey: OPP,
    familyEpds: overrides.familyEpds || ["e2e4 e7e5 g1f3"],
    replyUci: overrides.replyUci || "b8c6",
    coverageCost: overrides.coverageCost ?? 1,
    maxPly: overrides.maxPly ?? 12,
    wildcardPlyCount: overrides.wildcardPlyCount ?? 0,
    exactPly: overrides.exactPly ?? 3,
    display: overrides.display,
  });
}

describe("preparation-unit-v2 validation", () => {
  it("accepts valid cost-1 unit", () => {
    const u = makeUnit();
    const v = validatePreparationUnitV2(u);
    expect(v.ok).toBe(true);
    expect(u.unitContract).toBe(ORCBR_UNIT_CONTRACT_V2);
    expect(u.unitId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects coverageCost outside {1,2,3}", () => {
    const u = makeUnit();
    u.identityPayload.coverageCost = 4;
    u.unitId = undefined;
    const v = validatePreparationUnitV2(u);
    expect(v.ok).toBe(false);
  });

  it("rejects over-broad family for cost (fail-closed)", () => {
    const familyEpds = Array.from({ length: 13 }, (_, i) => `epd${i}`);
    expect(() => buildPreparationUnitV2({
      opponentKey: OPP,
      familyEpds,
      replyUci: "a7a6",
      coverageCost: 3,
    })).toThrow(/invalid preparation-unit-v2/);
  });

  it("cost monotone: broad matcher cannot claim cost 1", () => {
    const familyEpds = Array.from({ length: 9 }, (_, i) => `line${i}`);
    const min = inferMinCoverageCost({
      familyEpds,
      wildcardPlyCount: 0,
      maxPly: 12,
    });
    expect(min).toBeGreaterThan(1);
  });

  it("cost-1 refuses long single exact sequences (>6 ply)", () => {
    const min = inferMinCoverageCost({
      familyEpds: ["e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4"],
      wildcardPlyCount: 0,
      exactPly: 7,
      maxPly: 12,
    });
    expect(min).toBe(2);
  });

  it("display payload does not change unitId", () => {
    const a = makeUnit({ display: { title: "A" } });
    const b = makeUnit({ display: { title: "B totally different" } });
    expect(a.unitId).toBe(b.unitId);
  });

  it("rejects unsorted familyEpds (identity instability)", () => {
    const u = makeUnit({ familyEpds: ["z", "a"] });
    // build sorts — validate unsorted payload fails
    u.identityPayload.matcher.familyEpds = ["z", "a"];
    const v = validatePreparationUnitV2(u);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/sorted/);
  });
});

describe("exact-atom v1 compatibility (no silent rewrite)", () => {
  it("exact scorer rejects preparation-unit-v2", () => {
    const u = makeUnit();
    const v = validateExactAtomV1(u);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/rejects/);
  });

  it("generalized scorer rejects exact-atom@1", () => {
    const v = validateForGeneralizedScorer({
      unitContract: ORCBR_UNIT_CONTRACT_EXACT_V1,
      triggerEpd: "start",
      subjectUci: "e2e4",
    });
    expect(v.ok).toBe(false);
  });

  it("exact scorer accepts well-formed exact atom", () => {
    const v = validateExactAtomV1({
      unitContract: ORCBR_UNIT_CONTRACT_EXACT_V1,
      triggerEpd: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
      subjectUci: "e7e5",
    });
    expect(v.ok).toBe(true);
  });
});

describe("matcher + package budget", () => {
  it("matches same opponentKey + family prefix; rejects foreign key", () => {
    const u = makeUnit({ familyEpds: ["e2e4 e7e5 g1f3"] });
    const hit = matchUnitToGame(u, {
      color: "black",
      opponentKey: OPP,
      ucis: ["e2e4", "e7e5", "g1f3", "b8c6"],
    });
    expect(hit.match).toBe(true);
    expect(hit.contribution).toBe(1);

    const foreign = matchUnitToGame(u, {
      color: "black",
      opponentKey: "opp_ffffffffffff0000",
      ucis: ["e2e4", "e7e5", "g1f3", "b8c6"],
    });
    expect(foreign.match).toBe(false);
    expect(foreign.reason).toBe("foreign-opponentKey");
  });

  it("does not auto-credit bare ply:N:uci without explicit family token", () => {
    // Broad gaming guard: single-move ply tokens are not synthesized for free.
    const u = makeUnit({ familyEpds: ["ply:1:e2e4"] });
    const hit = matchUnitToGame(u, {
      color: "black",
      opponentKey: OPP,
      ucis: ["e2e4", "e7e5", "g1f3"],
    });
    // Only matches if game.familyTokens or explicit path equals — not auto ply:
    expect(hit.match).toBe(false);
  });

  it("package total cost must equal 12 for exact fill", () => {
    const units = Array.from({ length: 12 }, (_, i) => makeUnit({
      familyEpds: [`e2e4 line${i}`],
      replyUci: "e7e5",
    }));
    const v = validatePackage(units, { budget: PACKAGE_SLOT_BUDGET, requireExactFill: true });
    expect(v.ok).toBe(true);
    expect(v.totalCost).toBe(12);
  });

  it("rejects over-budget package", () => {
    const units = [
      makeUnit({ familyEpds: ["a"], coverageCost: 3, replyUci: "e7e5" }),
      makeUnit({ familyEpds: ["b"], coverageCost: 3, replyUci: "e7e5" }),
      makeUnit({ familyEpds: ["c"], coverageCost: 3, replyUci: "e7e5" }),
      makeUnit({ familyEpds: ["d"], coverageCost: 3, replyUci: "e7e5" }),
      makeUnit({ familyEpds: ["e"], coverageCost: 3, replyUci: "e7e5" }),
    ];
    // 15 > 12
    const v = validatePackage(units, { requireExactFill: false });
    expect(v.ok).toBe(false);
  });

  it("packUnitsToBudget fills exactly 12 deterministically", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      supportGames: 20 - i,
      supportDays: 5,
      unit: makeUnit({
        familyEpds: [`fam ${i}`],
        replyUci: "e7e5",
      }),
    }));
    const packed = packUnitsToBudget(candidates, { budget: 12, requireExactFill: false });
    expect(packed.totalCost).toBe(12);
    expect(packed.exactFill).toBe(true);
    const h1 = packageContentHash(packed.units);
    const packed2 = packUnitsToBudget(candidates, { budget: 12, requireExactFill: false });
    expect(packageContentHash(packed2.units)).toBe(h1);
  });

  it("rankUnits prefers more support then lower cost then unitId", () => {
    const a = {
      supportGames: 3,
      supportDays: 2,
      unit: makeUnit({ familyEpds: ["z"], coverageCost: 1 }),
    };
    const b = {
      supportGames: 5,
      supportDays: 1,
      unit: makeUnit({ familyEpds: ["y"], coverageCost: 1 }),
    };
    const ranked = rankUnits([a, b]);
    expect(ranked[0]).toBe(b);
  });

  it("slotNormalizedCoverage U = covered / sum cost; no double credit per game", () => {
    const units = [
      makeUnit({ familyEpds: ["e2e4 e7e5 g1f3"] }),
      makeUnit({ familyEpds: ["e2e4 e7e5"], replyUci: "g8f6" }),
    ];
    const games = [
      {
        color: "black",
        opponentKey: OPP,
        ucis: ["e2e4", "e7e5", "g1f3", "b8c6"],
      },
      {
        color: "black",
        opponentKey: OPP,
        ucis: ["d2d4", "d7d5"],
      },
    ];
    const { U, coveredGames, totalCost } = slotNormalizedCoverage(units, games);
    // Both units can match game0, but game counts once
    expect(coveredGames).toBe(1);
    expect(totalCost).toBe(2);
    expect(U).toBe(0.5);
  });
});
