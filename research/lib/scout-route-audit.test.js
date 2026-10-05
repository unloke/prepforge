import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import { epdOf } from "./scout-graph.js";
import {
  annotateAuditReport,
  annotateRoute,
  assessFragility,
  assessRobustness,
  buildCohortLabelMap,
  buildOurLineSoundReport,
  classifyRouteTier,
  CLAIM_LEVEL,
  cohortLabelFromRow,
  countActualReach,
  countEntryDiversity,
  countSubjectSamples,
  countSurvivors,
  deriveRiskLevel,
  deriveVerdict,
  epdFromUcis,
  extractActualPlayerResponses,
  multipvGapCp,
  normalizePolicyResponses,
  PRODUCT_COPY_RULES,
  PRODUCT_COPY_RULES_V12,
  ROBUSTNESS_MIN_CP,
  wrapModelAttribution,
} from "./scout-route-audit.js";

function scoutGame({ color = "white", ucis, sans }) {
  return {
    color,
    ucis,
    sans,
    openingUcis: ucis,
    score: 1,
    datestamp: 1_000_000,
    gameId: `g-${ucis?.join("-") ?? "empty"}`,
  };
}

describe("cohortLabelFromRow", () => {
  it("maps bhPass, insufficient, and default", () => {
    expect(cohortLabelFromRow({ bhPass: true, insufficient: false })).toBe("unusual");
    expect(cohortLabelFromRow({ bhPass: false, insufficient: true })).toBe("insufficient");
    expect(cohortLabelFromRow({ bhPass: false, insufficient: false })).toBe("cohort-common");
    expect(cohortLabelFromRow(null)).toBe("cohort-common");
  });

  it("buildCohortLabelMap indexes by feature id", () => {
    const map = buildCohortLabelMap({
      features: [
        { id: "isCastle", bhPass: true, insufficient: false },
        { id: "quietPawnPush", bhPass: false, insufficient: true },
      ],
    });
    expect(map.get("isCastle")).toBe("unusual");
    expect(map.get("quietPawnPush")).toBe("insufficient");
    expect(map.get("missing")).toBeUndefined();
  });
});

describe("countActualReach", () => {
  const lineA = ["c2c4", "d7d5", "d2d4", "e7e6"];
  const lineB = ["d2d4", "d7d5", "c2c4", "e7e6"];

  it("counts games reaching target EPD (transposition-aware)", () => {
    const chess = new Chess();
    for (const uci of lineA.slice(0, 3)) {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    }
    const targetEpd = epdOf(chess.fen());

    const games = [
      scoutGame({ ucis: lineA }),
      scoutGame({ ucis: lineB }),
      scoutGame({ ucis: ["e2e4", "e7e5"] }),
    ];
    const reach = countActualReach(games, targetEpd, "white", { maxPlies: 30 });
    expect(reach.passed).toBe(2);
    expect(reach.total).toBe(3);
    expect(reach.fraction).toBeCloseTo(2 / 3, 8);
  });

  it("epdFromUcis matches manual EPD after path", () => {
    expect(epdFromUcis(["e2e4", "c7c5"])).toBe(
      "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -",
    );
  });
});

describe("countSubjectSamples", () => {
  it("counts firing decisions and chosen moves for a feature", () => {
    const games = [
      scoutGame({ color: "black", ucis: ["e2e4", "e7e5", "g1f3", "b8c6"] }),
      scoutGame({ color: "black", ucis: ["e2e4", "e7e5", "g1f3", "g8f6"] }),
      scoutGame({ color: "white", ucis: ["e2e4", "e7e5"] }),
    ];
    const samples = countSubjectSamples(games, "developsMinorFromHome", "black", { maxPlies: 10 });
    expect(samples.firing).toBeGreaterThan(0);
    expect(samples.chose).toBeGreaterThan(0);
    expect(samples.chose).toBeLessThanOrEqual(samples.firing);
  });
});

describe("buildOurLineSoundReport", () => {
  it("passes when all losses ≤ 30cp", () => {
    const r = buildOurLineSoundReport([
      { uci: "e2e4", evalCp: 30, bestCp: 40 },
      { uci: "g1f3", evalCp: 20, bestCp: 45 },
    ]);
    expect(r.ourLineSound).toBe(true);
    expect(r.ourMoveLosses[1].lossCp).toBe(25);
  });

  it("fails when any loss > 30cp", () => {
    const r = buildOurLineSoundReport([{ uci: "d2d4", evalCp: 0, bestCp: 50 }]);
    expect(r.ourLineSound).toBe(false);
    expect(r.ourMoveLosses[0].lossCp).toBe(50);
  });
});

describe("assessRobustness", () => {
  it(`passes when all replies ≥ ${ROBUSTNESS_MIN_CP}cp`, () => {
    const r = assessRobustness([
      { san: "Nf6", piTilt: 0.4, evalAfterCp: -10 },
      { san: "e6", piTilt: 0.3, evalAfterCp: 5 },
      { san: "d6", piTilt: 0.2, evalAfterCp: ROBUSTNESS_MIN_CP },
    ]);
    expect(r.pass).toBe(true);
  });

  it("fails when any reply is below threshold", () => {
    const r = assessRobustness([
      { san: "Nf6", piTilt: 0.5, evalAfterCp: 10 },
      { san: "e6", piTilt: 0.3, evalAfterCp: ROBUSTNESS_MIN_CP - 1 },
    ]);
    expect(r.pass).toBe(false);
  });

  it("fails on empty reply list", () => {
    expect(assessRobustness([]).pass).toBe(false);
  });
});

describe("assessFragility", () => {
  it("narrowPath when any gap > 80cp", () => {
    const r = assessFragility([
      { ply: 2, gapCp: 40 },
      { ply: 4, gapCp: 81 },
    ]);
    expect(r.narrowPath).toBe(true);
    expect(r.ply).toBe(4);
  });

  it("no narrow path when all gaps ≤ 80cp", () => {
    const r = assessFragility([{ ply: 2, gapCp: 80 }, { ply: 4, gapCp: 30 }]);
    expect(r.narrowPath).toBe(false);
    expect(r.ply).toBeNull();
  });
});

describe("multipvGapCp", () => {
  it("computes our-perspective gap between top two lines", () => {
    const gap = multipvGapCp(
      { type: "cp", cp: 50 },
      { type: "cp", cp: 20 },
      "white",
      "white",
    );
    expect(gap.bestCp).toBe(50);
    expect(gap.secondCp).toBe(20);
    expect(gap.gapCp).toBe(30);
  });
});

describe("deriveRiskLevel", () => {
  const base = {
    ourLineSound: true,
    robustnessPass: true,
    actualReachPassed: 5,
    narrowPath: false,
    nodeEvalCp18: 20,
    subjectSamplesChose: 10,
  };

  it("high when line unsound", () => {
    expect(deriveRiskLevel({ ...base, ourLineSound: false })).toBe("high");
  });

  it("high when robustness fails", () => {
    expect(deriveRiskLevel({ ...base, robustnessPass: false })).toBe("high");
  });

  it("high when actual reach passed < 2", () => {
    expect(deriveRiskLevel({ ...base, actualReachPassed: 1 })).toBe("high");
  });

  it("medium when narrow path", () => {
    expect(deriveRiskLevel({ ...base, narrowPath: true })).toBe("medium");
  });

  it("medium when node eval < 15", () => {
    expect(deriveRiskLevel({ ...base, nodeEvalCp18: 14 })).toBe("medium");
  });

  it("medium when subject chose < 5", () => {
    expect(deriveRiskLevel({ ...base, subjectSamplesChose: 4 })).toBe("medium");
  });

  it("low when all checks clear", () => {
    expect(deriveRiskLevel(base)).toBe("low");
  });
});

describe("deriveVerdict", () => {
  it("passes on low risk with sound robust line", () => {
    const v = deriveVerdict({
      riskLevel: "low",
      ourLineSound: true,
      robustnessPass: true,
      actualReachPassed: 5,
    });
    expect(v.verdict).toBe("pass");
    expect(v.reasons).toEqual([]);
  });

  it("passes on medium risk when sound and robust", () => {
    const v = deriveVerdict({
      riskLevel: "medium",
      ourLineSound: true,
      robustnessPass: true,
      actualReachPassed: 5,
      narrowPath: true,
    });
    expect(v.verdict).toBe("pass");
  });

  it("fails with reasons on high risk", () => {
    const v = deriveVerdict({
      riskLevel: "high",
      ourLineSound: false,
      robustnessPass: false,
      actualReachPassed: 0,
    });
    expect(v.verdict).toBe("fail");
    expect(v.reasons).toContain("our line unsound at d18");
    expect(v.reasons).toContain("robustness failed vs top-3 tilted replies");
    expect(v.reasons).toContain("actual reach < 2 games");
    expect(v.reasons).toContain("risk level high");
  });
});

describe("wrapModelAttribution", () => {
  it("wraps probabilities under internal with note", () => {
    const w = wrapModelAttribution(1.5, {
      san: "Nf6",
      uci: "g8f6",
      piTilt: 0.4,
      piRaw: 0.3,
      deltaCp: 20,
    });
    expect(w.internal.attribution).toBe(1.5);
    expect(w.internal.topLeakMove.piTilt).toBe(0.4);
    expect(w.internal.note).toMatch(/MUST NOT appear in product copy/);
  });
});

describe("countEntryDiversity and survivors", () => {
  it("counts distinct entry keys for our moves", () => {
    const routes = [
      { ucis: ["e2e4", "c7c5", "g1f3"] },
      { ucis: ["d2d4", "d7d5"] },
      { ucis: ["c2c4", "e7e5", "b1c3"] },
    ];
    expect(countEntryDiversity(routes, "black")).toBe(3);
  });

  it("countSurvivors tallies pass verdicts", () => {
    expect(countSurvivors([{ verdict: "pass" }, { verdict: "fail" }, { verdict: "pass" }])).toBe(2);
  });
});

describe("product constants", () => {
  it("exposes claim level and copy rules", () => {
    expect(CLAIM_LEVEL).toBe("tendency-aligned prep route");
    expect(PRODUCT_COPY_RULES).toHaveLength(3);
    expect(PRODUCT_COPY_RULES_V12.length).toBeGreaterThan(PRODUCT_COPY_RULES.length);
  });
});

function passRoute(over = {}) {
  return {
    verdict: "pass",
    nodeGames: 3,
    riskLevel: "low",
    fragility: { narrowPath: false },
    sfVerify: { nodeEvalCp18: 0 },
    robustness: {
      pass: true,
      replies: [{ san: "Nf6", piTilt: 0.4, evalAfterCp: 0 }],
    },
    ...over,
  };
}

describe("classifyRouteTier", () => {
  it("grades advantage when node, replies, risk, and fragility clear", () => {
    const tier = classifyRouteTier(
      passRoute({
        sfVerify: { nodeEvalCp18: 32 },
        robustness: {
          pass: true,
          replies: [
            { san: "a", evalAfterCp: 33 },
            { san: "b", evalAfterCp: 66 },
            { san: "c", evalAfterCp: 118 },
          ],
        },
      }),
    );
    expect(tier).toBe("advantage");
  });

  it("grades safe when node >= -20 even if a reply is below +20", () => {
    const tier = classifyRouteTier(
      passRoute({
        sfVerify: { nodeEvalCp18: -8 },
        robustness: {
          pass: true,
          replies: [
            { san: "a", evalAfterCp: 10 },
            { san: "b", evalAfterCp: -5 },
          ],
        },
      }),
    );
    expect(tier).toBe("safe");
  });

  it("blocks advantage on medium risk", () => {
    const tier = classifyRouteTier(
      passRoute({
        riskLevel: "medium",
        sfVerify: { nodeEvalCp18: 32 },
        robustness: {
          pass: true,
          replies: [
            { san: "a", evalAfterCp: 33 },
            { san: "b", evalAfterCp: 66 },
          ],
        },
      }),
    );
    expect(tier).toBe("safe");
  });

  it("downgrades one tier when nodeGames is 0", () => {
    expect(
      classifyRouteTier(
        passRoute({
          nodeGames: 0,
          sfVerify: { nodeEvalCp18: 32 },
          robustness: {
            pass: true,
            replies: [
              { san: "a", evalAfterCp: 33 },
              { san: "b", evalAfterCp: 66 },
            ],
          },
        }),
      ),
    ).toBe("safe");
    expect(
      classifyRouteTier(
        passRoute({
          nodeGames: 0,
          sfVerify: { nodeEvalCp18: -8 },
        }),
      ),
    ).toBe("info");
  });

  it("returns null for fail verdict", () => {
    expect(classifyRouteTier({ verdict: "fail" })).toBeNull();
  });
});

describe("extractActualPlayerResponses", () => {
  const route = {
    ucis: ["e2e4", "c7c5"],
  };

  it("counts subject reply when one game follows the route prefix", () => {
    const games = [
      scoutGame({ color: "white", score: 1, ucis: ["e2e4", "c7c5", "g1f3", "d7d6"] }),
      scoutGame({ color: "white", score: 0, ucis: ["e2e4", "e7e5", "g1f3"] }),
    ];
    const out = extractActualPlayerResponses(games, route, "white");
    expect(out.responses).toHaveLength(1);
    expect(out.responses[0].san).toBe("Nf3");
    expect(out.responses[0].count).toBe(1);
    expect(out.responses[0].wins).toBe(1);
    expect(out.responses[0].losses).toBe(0);
  });

  it("returns note when no games reach the node", () => {
    const out = extractActualPlayerResponses(
      [scoutGame({ ucis: ["d2d4", "d7d5"] })],
      route,
      "white",
    );
    expect(out.responses).toEqual([]);
    expect(out.note).toBe("no actual games reach this node");
  });
});

describe("annotateRoute and annotateAuditReport", () => {
  it("moves piTilt under internal on policyResponses", () => {
    const annotated = annotateRoute(
      passRoute({
        ucis: ["e2e4", "c7c5"],
        robustness: {
          pass: true,
          replies: [{ san: "Nf3", piTilt: 0.42, evalAfterCp: 5 }],
        },
      }),
      [],
      "white",
    );
    expect(annotated.policyResponses[0].internal.piTilt).toBe(0.42);
    expect(annotated.policyResponses[0].piTilt).toBeUndefined();
    expect(normalizePolicyResponses(annotated.policyResponses)[0].internal.piTilt).toBe(0.42);
  });

  it("annotateAuditReport extends productCopyRules and tiers routes", () => {
    const report = annotateAuditReport(
      {
        meta: { subjectColor: "white" },
        tendencies: [
          {
            featureId: "isCastle",
            routes: [passRoute({ sfVerify: { nodeEvalCp18: -8 } })],
          },
        ],
      },
      [],
    );
    expect(report.productCopyRules).toEqual(PRODUCT_COPY_RULES_V12);
    expect(report.tendencies[0].routes[0].tier).toBe("safe");
    expect(report.meta.annotatedAt).toBeTruthy();
  });
});