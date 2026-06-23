import { describe, expect, it } from "vitest";
import {
  SCOUT_PREFILTER_MIN_CP_LOSS,
  SCOUT_PREFILTER_LIMIT,
  SCOUT_PREFILTER_POOL_SIZE,
  buildFallbackPrefilterData,
  computePrefilterScopeKey,
  collectPrefilterFens,
  collapseNestedPrefilterLines,
  mergeGlobalPrefilterRanked,
  rankPrefilterCandidates,
  scorePrefilterLine,
} from "./scout-prefilter.js";
import { fenAfterLine } from "./scout.js";

const OPP = "white";

function evalMapForLine(ucis, oppColor, { cpLoss = 30, bestUci = null } = {}) {
  const before = ucis.slice(0, -1);
  const fenBefore = fenAfterLine(before);
  const fenLeaf = fenAfterLine(ucis);
  const played = ucis[ucis.length - 1];
  const beforeCp = 20;
  const afterCp =
    oppColor === "white" ? beforeCp - cpLoss : beforeCp + cpLoss;
  return new Map([
    [
      fenBefore,
      {
        score_cp: beforeCp,
        best_move_uci: bestUci || played,
      },
    ],
    [
      fenLeaf,
      {
        score_cp: afterCp,
        best_move_uci: "d2d4",
      },
    ],
  ]);
}

describe("scout-prefilter scoring", () => {
  it("scores lines with objective cp loss and a user reply", () => {
    const ucis = ["e2e4", "e7e5", "g1f3"];
    const line = { ucis, sans: ["e4", "e5", "Nf3"], games: 3, share: 0.2 };
    const metrics = scorePrefilterLine(line, evalMapForLine(ucis, OPP, { cpLoss: 40, bestUci: "g8f6" }), {
      fenAfterLine,
      oppColor: OPP,
    });
    expect(metrics?.cpLoss).toBe(40);
    expect(metrics?.hasUserReply).toBe(true);
  });

  it("excludes lines with no user reply at the leaf", () => {
    const ucis = ["e2e4", "e7e5"];
    const line = { ucis, sans: ["e4", "e5"], games: 1 };
    const fenBefore = fenAfterLine(["e2e4"]);
    const fenLeaf = fenAfterLine(ucis);
    const evalMap = new Map([
      [fenBefore, { score_cp: 10, best_move_uci: "e7e5" }],
      [fenLeaf, { score_cp: 10, best_move_uci: null }],
    ]);
    expect(
      scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor: OPP }),
    ).toBeNull();
  });

  it("collects distinct before/leaf FENs across lines", () => {
    const lines = [
      { ucis: ["e2e4", "e7e5", "g1f3"], sans: ["e4", "e5", "Nf3"], games: 1 },
      { ucis: ["e2e4", "c7c5", "g1f3"], sans: ["e4", "c5", "Nf3"], games: 1 },
    ];
    const fens = collectPrefilterFens(lines, { fenAfterLine, oppColor: OPP });
    expect(fens.length).toBe(4);
    expect(new Set(fens).size).toBe(4);
  });

  it("excludes tiny cp-loss lines even when the played move is not byte-identical to best", () => {
    const ucis = ["e2e4", "e7e5", "g1f3"];
    const line = { ucis, sans: ["e4", "e5", "Nf3"], games: 1 };
    const metrics = scorePrefilterLine(
      line,
      evalMapForLine(ucis, OPP, { cpLoss: SCOUT_PREFILTER_MIN_CP_LOSS - 1, bestUci: "b1c3" }),
      { fenAfterLine, oppColor: OPP },
    );
    expect(metrics).toBeNull();
  });

  it("keeps the higher-scoring parent when a nested descendant scores lower", () => {
    const parent = {
      line: { ucis: ["e2e4", "e7e5"], line: "e2e4>e7e5" },
      prefilterScore: 40,
    };
    const child = {
      line: { ucis: ["e2e4", "e7e5", "g1f3"], line: "e2e4>e7e5>g1f3" },
      prefilterScore: 10,
    };
    const collapsed = collapseNestedPrefilterLines([parent, child]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].prefilterScore).toBe(40);
  });

  it("merges both colours by objective score, not section order", () => {
    const merged = mergeGlobalPrefilterRanked({
      white: [{ line: { ucis: ["w"], share: 0.9 }, prefilterScore: 12, hasUserReply: true }],
      black: [{ line: { ucis: ["b"], share: 0.1 }, prefilterScore: 40, hasUserReply: true }],
    });
    expect(merged[0].oppColor).toBe("black");
    expect(merged[0].prefilterScore).toBe(40);
  });

  it("does not collapse shared UCI prefixes across opponent colours", () => {
    const merged = mergeGlobalPrefilterRanked({
      white: [{ line: { ucis: ["e2e4"], line: "e2e4" }, prefilterScore: 30, hasUserReply: true }],
      black: [
        {
          line: { ucis: ["e2e4", "e7e5"], line: "e2e4>e7e5" },
          prefilterScore: 20,
          hasUserReply: true,
        },
      ],
    });
    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.oppColor).sort()).toEqual(["black", "white"]);
  });

  it("ranks higher cp-loss lines first with recency/share as tiebreak only", () => {
    const deep = {
      ucis: ["e2e4", "e7e5", "g1f3", "b8c6"],
      sans: ["e4", "e5", "Nf3", "Nc6"],
      games: 1,
      share: 0.01,
      lastDatestamp: 2000,
    };
    const shallow = {
      ucis: ["e2e4", "e7e5"],
      sans: ["e4", "e5"],
      games: 20,
      share: 0.8,
      lastDatestamp: 1000,
    };
    const evalMap = new Map([
      ...evalMapForLine(deep.ucis, "black", { cpLoss: 50, bestUci: "a7a6" }),
      ...evalMapForLine(shallow.ucis, "black", { cpLoss: 10, bestUci: "c7c6" }),
    ]);
    const ranked = rankPrefilterCandidates([shallow, deep], evalMap, {
      fenAfterLine,
      oppColor: "black",
    });
    expect(ranked[0].line.ucis).toEqual(deep.ucis);
  });
});

describe("computePrefilterScopeKey", () => {
  it("keys readiness on speed and ingested game count", () => {
    expect(computePrefilterScopeKey({ activeSpeed: "blitz", gameCount: 12 })).toBe("blitz|12");
    expect(computePrefilterScopeKey({ activeSpeed: "all", gameCount: 24 })).toBe("all|24");
  });
});

describe("buildFallbackPrefilterData", () => {
  it("builds ranked pool and display lines from opening-line order", () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      ucis: [`m${i}`],
      sans: [`m${i}`],
      games: 1,
    }));
    const { ranked, pool, maiaLines } = buildFallbackPrefilterData(lines);
    expect(pool).toHaveLength(SCOUT_PREFILTER_POOL_SIZE);
    expect(ranked).toHaveLength(SCOUT_PREFILTER_POOL_SIZE);
    expect(maiaLines).toHaveLength(SCOUT_PREFILTER_LIMIT);
    expect(maiaLines[0].ucis).toEqual(["m0"]);
    expect(ranked[0].prefilterScore).toBe(0);
  });
});