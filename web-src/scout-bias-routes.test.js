import { describe, expect, it } from "vitest";

import {
  attributionForFeature,
  clampDeltaCp,
  collapseSameEntry,
  expectedLoss,
  isNestedPath,
  isPathPrefix,
  isRouteSound,
  jeffreysLower,
  moveDeltaCp,
  ourEntryKey,
  parseSfInfoScore,
  pathReachLB,
  pickStableTendencies,
  rankScore,
  rawProbs,
  selectDistinctRoutes,
  sfScoreToOurCp,
  tendencyVerdict,
  tiltedProbs,
  topLeakMove,
} from "./scout-bias-routes.js";

describe("tiltedProbs", () => {
  const cands = [
    { uci: "e2e4", p: 0.5, f: [1, 0] },
    { uci: "d2d4", p: 0.5, f: [0, 1] },
  ];

  it("β=0 → π_tilt equals π_raw", () => {
    const beta = [0, 0];
    const tilt = tiltedProbs(cands, beta);
    const raw = rawProbs(cands);
    for (let i = 0; i < tilt.length; i += 1) {
      expect(tilt[i]).toBeCloseTo(raw[i], 10);
    }
  });

  it("positive β on a firing feature raises that move's probability", () => {
    const beta = [2, 0];
    const tilt = tiltedProbs(cands, beta);
    const raw = rawProbs(cands);
    expect(tilt[0]).toBeGreaterThan(raw[0]);
    expect(tilt[1]).toBeLessThan(raw[1]);
  });
});

describe("Δ and ELoss", () => {
  it("Δ = max(0, best − after) clamped to 500", () => {
    expect(moveDeltaCp(20, 50)).toBe(30);
    expect(moveDeltaCp(80, 50)).toBe(0);
    expect(clampDeltaCp(900)).toBe(500);
    expect(clampDeltaCp(-5)).toBe(0);
  });

  it("ELoss weights deltas by policy mass", () => {
    const probs = [0.6, 0.4];
    const deltas = [10, 40];
    expect(expectedLoss(probs, deltas)).toBeCloseTo(0.6 * 10 + 0.4 * 40, 8);
  });
});

describe("attributionForFeature", () => {
  it("positive when bad move fires feature with β>0", () => {
    const cands = [
      { uci: "bad", p: 0.05, f: [1, 0] },
      { uci: "good", p: 0.95, f: [0, 0] },
    ];
    const beta = [3, 0];
    const deltas = [80, 0];
    const attr = attributionForFeature(cands, beta, 0, deltas);
    expect(attr).toBeGreaterThan(0);
  });

  it("zero when β_f is zeroed (no active feature)", () => {
    const cands = [
      { uci: "bad", p: 0.05, f: [1, 0] },
      { uci: "good", p: 0.95, f: [0, 0] },
    ];
    const beta = [3, 0];
    const deltas = [80, 0];
    const mask = [false, false];
    const attr = attributionForFeature(cands, beta, 0, deltas, mask);
    expect(attr).toBeCloseTo(0, 10);
  });
});

describe("jeffreysLower", () => {
  it("matches Beta(k+0.5, n−k+0.5) Jeffreys anchors (design §2.2 ≈ values)", () => {
    expect(jeffreysLower(1, 6)).toBeCloseTo(0.05, 1);
    expect(jeffreysLower(9, 12)).toBeCloseTo(0.57, 1);
    expect(jeffreysLower(5, 5)).toBeCloseTo(0.77, 1);
    expect(jeffreysLower(1, 1)).toBeCloseTo(0.35, 1);
  });

  it("returns 0 for empty or zero counts", () => {
    expect(jeffreysLower(0, 5)).toBe(0);
    expect(jeffreysLower(1, 0)).toBe(0);
  });
});

describe("pathReachLB", () => {
  it("multiplies Jeffreys at HIS plies; OUR plies contribute 1", () => {
    const segments = [
      { isHisMove: true, childGames: 5, parentGames: 5 },
      { isHisMove: false, childGames: 5, parentGames: 5 },
      { isHisMove: true, childGames: 9, parentGames: 12 },
    ];
    const expected =
      jeffreysLower(5, 5) * jeffreysLower(9, 12);
    expect(pathReachLB(segments)).toBeCloseTo(expected, 8);
  });

  it("empty path → 1", () => {
    expect(pathReachLB([])).toBe(1);
  });
});

describe("sfScoreToOurCp", () => {
  it("negates when side-to-move is not our color", () => {
    expect(sfScoreToOurCp({ type: "cp", cp: 40 }, "white", "black")).toBe(-40);
    expect(sfScoreToOurCp({ type: "cp", cp: 40 }, "black", "black")).toBe(40);
  });

  it("mate-in-1 for us: side to move reports mate 1 → +1000 from our POV", () => {
    const line = "info depth 14 seldepth 20 multipv 1 score mate 1 nodes 1000 nps 50000";
    const cp = parseSfInfoScore(line, "white", "white");
    expect(cp).toBe(1000);
  });

  it("mate-in-1 against us: opponent to move mate 1 → −1000 from our POV", () => {
    const line = "info depth 14 score mate 1";
    const cp = parseSfInfoScore(line, "black", "white");
    expect(cp).toBe(-1000);
  });
});

describe("isRouteSound", () => {
  it("rejects node eval below −30cp", () => {
    expect(isRouteSound(-31, [])).toBe(false);
    expect(isRouteSound(-30, [])).toBe(true);
  });

  it("rejects path moves more than 30cp below best", () => {
    expect(
      isRouteSound(10, [{ evalCp: 0, bestCp: 50 }]),
    ).toBe(false);
    expect(
      isRouteSound(10, [{ evalCp: 25, bestCp: 50 }]),
    ).toBe(true);
  });
});

describe("selectDistinctRoutes", () => {
  const mk = (id, ourMoves, score, sound = true) => ({
    id,
    ourMoves,
    rankScore: score,
    sound,
  });

  it("greedily picks 3 with distinct entries", () => {
    const ranked = [
      mk("a", ["e7e5"], 100),
      mk("b", ["c7c5"], 90),
      mk("c", ["e7e6"], 80),
      mk("d", ["g8f6"], 70),
    ];
    const picked = selectDistinctRoutes(ranked, { maxRoutes: 3 });
    expect(picked.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("collapses same-entry duplicates (keeps best)", () => {
    const ranked = [
      mk("best", ["e7e5", "g8f6", "f8e7", "e8g8"], 100),
      mk("dup", ["e7e5", "g8f6", "f8e7", "d7d6"], 50),
      mk("other", ["c7c5"], 40),
    ];
    const collapsed = collapseSameEntry(ranked);
    expect(collapsed[0].id).toBe("best");
    expect(collapsed.some((c) => c.id === "dup")).toBe(false);
    const picked = selectDistinctRoutes(collapsed, { maxRoutes: 3 });
    expect(picked.map((p) => p.id)).toEqual(["best", "other"]);
  });

  it("collapses move-order transpositions (same epd) into one route", () => {
    const ranked = [
      { ...mk("orderA", ["d5", "g8f6"], 100), epd: "same-pos" },
      { ...mk("orderB", ["g8f6", "d5"], 90), epd: "same-pos" },
      { ...mk("other", ["c7c5"], 40), epd: "other-pos" },
    ];
    const picked = selectDistinctRoutes(ranked, { maxRoutes: 3 });
    expect(picked.map((p) => p.id)).toEqual(["orderA", "other"]);
  });

  it("drops unsound nodes", () => {
    const ranked = [
      mk("bad", ["e7e5"], 200, false),
      mk("ok", ["c7c5"], 50, true),
    ];
    const picked = selectDistinctRoutes(ranked);
    expect(picked.map((p) => p.id)).toEqual(["ok"]);
  });

  it("rejects ancestor/descendant of an already-picked route (parent+grandchild bug)", () => {
    const parent = {
      ...mk("parent", ["e2e4", "g1f3"], 100),
      pathUcis: ["e2e4", "c7c5", "g1f3", "d7d6"],
    };
    const grandchild = {
      ...mk("grandchild", ["e2e4", "g1f3", "d2d4"], 90),
      pathUcis: ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"],
    };
    const other = {
      ...mk("other", ["d2d4", "c2c4"], 40),
      pathUcis: ["d2d4", "d7d5", "c2c4", "e7e6"],
    };
    const picked = selectDistinctRoutes([parent, grandchild, other], { maxRoutes: 3 });
    expect(picked.map((p) => p.id)).toEqual(["parent", "other"]);
  });
});

describe("isPathPrefix / isNestedPath", () => {
  it("detects prefix relations", () => {
    expect(isPathPrefix(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(isPathPrefix(["a", "b", "c"], ["a", "b"])).toBe(false);
    expect(isPathPrefix(["a", "x"], ["a", "b", "c"])).toBe(false);
    expect(isPathPrefix(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("isNestedPath is symmetric", () => {
    expect(isNestedPath(["a", "b", "c"], ["a", "b"])).toBe(true);
    expect(isNestedPath(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(isNestedPath(["a", "b"], ["a", "c"])).toBe(false);
  });
});

describe("ourEntryKey", () => {
  it("joins OUR moves within the first 6 plies (3 our-moves)", () => {
    const moves = ["e7e5", "g8f6", "b8c6", "f8e7"];
    expect(ourEntryKey(moves)).toBe("e7e5 g8f6 b8c6");
  });
  it("routes sharing a forced first reply but diverging later are distinct entries", () => {
    expect(ourEntryKey(["e7e5", "g8f6"])).not.toBe(ourEntryKey(["e7e5", "b8c6"]));
  });
});

describe("rankScore", () => {
  it("multiplies reach by attribution", () => {
    expect(rankScore(0.5, 20)).toBeCloseTo(10, 8);
    expect(rankScore(0.5, -1)).toBe(0);
  });
});

describe("pickStableTendencies", () => {
  const ids = ["f0", "f1", "f2"];

  it("uses reliability.features when present", () => {
    const report = {
      reliability: {
        features: [
          { id: "f0", stable: true, betaFull: 0.5, zFull: 3 },
          { id: "f1", stable: false, betaFull: 1, zFull: 4 },
        ],
      },
    };
    const out = pickStableTendencies(report, ids);
    expect(out).toHaveLength(1);
    expect(out[0].featureId).toBe("f0");
    expect(out[0].source).toBe("reliability");
  });

  it("falls back to featuresByAbsZ |z|≥2", () => {
    const report = {
      fit: {
        beta: { f2: 0.8 },
        featuresByAbsZ: [
          { id: "f2", z: 2.5, beta: 0.8 },
          { id: "f1", z: 1.2, beta: 0.1 },
        ],
      },
    };
    const out = pickStableTendencies(report, ids);
    expect(out).toHaveLength(1);
    expect(out[0].featureId).toBe("f2");
    expect(out[0].source).toBe("featuresByAbsZ_fallback");
  });
});

describe("tendencyVerdict", () => {
  it("prep when ≥1 route, else analysis-only", () => {
    expect(tendencyVerdict([{}])).toBe("prep");
    expect(tendencyVerdict([])).toBe("analysis-only");
  });
});

describe("topLeakMove", () => {
  it("picks move with highest π_tilt·Δ", () => {
    const cands = [
      { uci: "a", san: "a" },
      { uci: "b", san: "b" },
    ];
    const piTilt = [0.2, 0.8];
    const piRaw = [0.5, 0.5];
    const deltas = [100, 10];
    const top = topLeakMove(cands, piTilt, piRaw, deltas);
    expect(top.uci).toBe("a");
    expect(top.deltaCp).toBe(100);
  });
});