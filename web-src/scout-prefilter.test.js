import { describe, expect, it } from "vitest";
import {
  SCOUT_MAIA_PREFILTER_LIMIT,
  SCOUT_PREFILTER_LIMIT,
  SCOUT_PREFILTER_POOL_SIZE,
  buildFallbackPrefilterData,
  computePrefilterScopeKey,
  collectPrefilterFens,
  collapseNestedPrefilterLines,
  mergeGlobalPrefilterRanked,
  prefilterCacheKey,
  prefilterMaiaLines,
  prefilterPoolLines,
  rankPrefilterCandidates,
  scorePrefilterLine,
} from "./scout-prefilter.js";
import { fenAfterLine } from "./scout.js";

const OPP = "white";

function ancestorFreqForLine(ucis, frequency = 0.05) {
  const fenBefore = fenAfterLine(ucis.slice(0, -1));
  return new Map([[fenBefore, { count: 1, frequency }]]);
}

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
    const metrics = scorePrefilterLine(
      line,
      evalMapForLine(ucis, OPP, { cpLoss: 40, bestUci: "g8f6" }),
      {
        fenAfterLine,
        oppColor: OPP,
        ancestorFreq: ancestorFreqForLine(ucis, 0.12),
      },
    );
    expect(metrics?.hasUserReply).toBe(true);
    expect(metrics?.prefilterScore).toBe(20);   // userLeafAdvantage = -(-20) = 20
    expect(metrics?.cpLoss).toBeUndefined();     // cp-loss is gone (leaf-only scoring)
    expect(metrics?.ancestorFrequency).toBe(0.12);
  });

  it("scores a user-favourable mate at the leaf and ignores an opponent mate", () => {
    const ucis = ["e2e4"]; // white-terminal; user is black (oppColor white)
    const line = { ucis, sans: ["e4"], games: 1 };
    const fenLeaf = fenAfterLine(ucis);
    // mate_in is White-POV; -3 means Black (the user here) is mating.
    const userMate = scorePrefilterLine(
      line,
      new Map([[fenLeaf, { score_cp: 0, mate_in: -3, best_move_uci: null }]]),
      { fenAfterLine, oppColor: OPP },
    );
    expect(userMate?.mateIn).toBe(3);
    expect(userMate?.hasUserReply).toBe(true);
    // +3 means White is mating the user — not a prep target.
    const oppMate = scorePrefilterLine(
      line,
      new Map([[fenLeaf, { score_cp: 0, mate_in: 3, best_move_uci: null }]]),
      { fenAfterLine, oppColor: OPP },
    );
    expect(oppMate).toBeNull();
  });

  it("excludes lines with no user reply at the leaf", () => {
    // White-terminal line; its leaf eval has neither a reply move nor a user-favourable mate.
    const ucis = ["e2e4"];
    const line = { ucis, sans: ["e4"], games: 1 };
    const fenLeaf = fenAfterLine(ucis);
    const evalMap = new Map([[fenLeaf, { score_cp: 10, best_move_uci: null }]]);
    expect(
      scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor: OPP }),
    ).toBeNull();
  });

  it("collects one distinct leaf FEN per line (leaf-only)", () => {
    const lines = [
      { ucis: ["e2e4", "e7e5", "g1f3"], sans: ["e4", "e5", "Nf3"], games: 1 },
      { ucis: ["e2e4", "c7c5", "g1f3"], sans: ["e4", "c5", "Nf3"], games: 1 },
    ];
    const fens = collectPrefilterFens(lines, { fenAfterLine, oppColor: OPP });
    expect(fens.length).toBe(2);
    expect(new Set(fens).size).toBe(2);
  });

  it("ranks line by leaf position quality even when last-move cp-loss is small", () => {
    const ucis = ["e2e4", "e7e5", "g1f3"];
    const line = { ucis, sans: ["e4", "e5", "Nf3"], games: 1 };
    const metrics = scorePrefilterLine(
      line,
      evalMapForLine(ucis, OPP, { cpLoss: 5, bestUci: "b1c3" }),
      { fenAfterLine, oppColor: OPP },
    );
    expect(metrics?.prefilterScore).toBe(-15);
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

  it("merges both colours by reproducibility score, not section order", () => {
    const merged = mergeGlobalPrefilterRanked({
      white: [
        {
          line: { ucis: ["w"], share: 0.9 },
          prefilterScore: 40,
          ancestorFrequency: 0.02,
          hasUserReply: true,
        },
      ],
      black: [
        {
          line: { ucis: ["b"], share: 0.1 },
          prefilterScore: 40,
          ancestorFrequency: 0.05,
          hasUserReply: true,
        },
      ],
    });
    expect(merged[0].oppColor).toBe("black");
    expect(merged[0].ancestorFrequency).toBe(0.05);
  });

  it("keeps up to SCOUT_PREFILTER_POOL_SIZE entries for Maia backup headroom", () => {
    const white = Array.from({ length: 40 }, (_, i) => ({
      line: { ucis: [`w${i}`] },
      prefilterScore: i,
      hasUserReply: true,
    }));
    const black = Array.from({ length: 40 }, (_, i) => ({
      line: { ucis: [`b${i}`] },
      prefilterScore: 100 - i,
      hasUserReply: true,
    }));
    const merged = mergeGlobalPrefilterRanked({ white, black });
    expect(merged).toHaveLength(SCOUT_PREFILTER_POOL_SIZE);
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

  it("ranks the more reproducible line first at equal advantage and no measured struggle", () => {
    // Two unrelated (non-nested) lines at equal Stockfish edge and no empirical struggle
    // signal: the line backed by more games is the more reproducible prep, so it wins on the
    // log-compressed reproducibility weight — frequency stays a tiebreaker, not a gate.
    const mainSystem = {
      ucis: ["e2e4", "e7e5"],
      sans: ["e4", "e5"],
      games: 20,
      share: 0.8,
      lastDatestamp: 1000,
    };
    const rareSideline = {
      ucis: ["c2c4", "e7e5"],
      sans: ["c4", "e5"],
      games: 1,
      share: 0.01,
      lastDatestamp: 2000,
    };
    const evalMap = new Map([
      ...evalMapForLine(mainSystem.ucis, "black", { cpLoss: 30, bestUci: "c7c6" }),
      ...evalMapForLine(rareSideline.ucis, "black", { cpLoss: 30, bestUci: "a7a6" }),
    ]);
    const ancestorFreq = new Map([
      [fenAfterLine(["e2e4"]), { count: 20, frequency: 0.1 }],
      [fenAfterLine(["c2c4"]), { count: 1, frequency: 0.005 }],
    ]);
    const ranked = rankPrefilterCandidates([rareSideline, mainSystem], evalMap, {
      fenAfterLine,
      oppColor: "black",
      ancestorFreq,
    });
    expect(ranked[0].line.ucis).toEqual(mainSystem.ucis);
    expect(ranked[0].ancestorFrequency).toBe(0.1);
  });

  it("surfaces a rare line where the opponent blundered (no frequency floor)", () => {
    // The whole point of the tool: a rare reply the opponent walked into a clearly worse
    // position with must surface, even though the old +20cp AND ancestor-frequency wall
    // would have dropped it as too infrequent.
    const rareBlunder = {
      ucis: ["e2e4", "e7e5"],
      sans: ["e4", "e5"],
      games: 1,
      share: 0.01,
    };
    const evalMap = evalMapForLine(rareBlunder.ucis, "black", { cpLoss: 50, bestUci: "c7c6" });
    const ranked = rankPrefilterCandidates([rareBlunder], evalMap, {
      fenAfterLine,
      oppColor: "black",
      ancestorFreq: ancestorFreqForLine(rareBlunder.ucis, 0.005),
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].line.ucis).toEqual(rareBlunder.ucis);
  });

  it("excludes frequent lines where opponent empirically performs at/above baseline", () => {
    const comfortable = {
      ucis: ["e2e4", "e7e5"],
      sans: ["e4", "e5"],
      games: 20,
      w: 12,
      d: 2,
      l: 6,
      scorePct: 65,
      share: 0.8,
    };
    const evalMap = evalMapForLine(comfortable.ucis, "black", { cpLoss: 30, bestUci: "c7c6" });
    const ancestorFreq = new Map([
      [
        fenAfterLine(["e2e4"]),
        { count: 20, frequency: 0.1, w: 12, d: 2, l: 6, games: 20, scorePct: 65 },
      ],
    ]);
    const ranked = rankPrefilterCandidates([comfortable], evalMap, {
      fenAfterLine,
      oppColor: "black",
      ancestorFreq,
      baselineScorePct: 50,
    });
    expect(ranked).toHaveLength(0);
  });

  it("ranks struggling frequent lines above comfortable ones at equal Stockfish edge", () => {
    const comfortable = {
      ucis: ["e2e4", "e7e5"],
      sans: ["e4", "e5"],
      games: 20,
      w: 12,
      d: 2,
      l: 6,
      scorePct: 65,
      share: 0.8,
    };
    const struggling = {
      ucis: ["d2d4", "d7d5"],
      sans: ["d4", "d5"],
      games: 18,
      w: 5,
      d: 2,
      l: 11,
      scorePct: 33,
      share: 0.7,
    };
    const evalMap = new Map([
      ...evalMapForLine(comfortable.ucis, "black", { cpLoss: 30, bestUci: "c7c6" }),
      ...evalMapForLine(struggling.ucis, "black", { cpLoss: 30, bestUci: "e7e6" }),
    ]);
    const ancestorFreq = new Map([
      [
        fenAfterLine(["e2e4"]),
        { count: 20, frequency: 0.1, w: 12, d: 2, l: 6, games: 20, scorePct: 65 },
      ],
      [
        fenAfterLine(["d2d4"]),
        { count: 18, frequency: 0.09, w: 5, d: 2, l: 11, games: 18, scorePct: 33 },
      ],
    ]);
    const ranked = rankPrefilterCandidates([comfortable, struggling], evalMap, {
      fenAfterLine,
      oppColor: "black",
      ancestorFreq,
      baselineScorePct: 50,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].line.ucis).toEqual(struggling.ucis);
  });

  it("populates funnelOut with per-stage drop counts", () => {
    const noReply = {
      ucis: ["e2e4", "e7e5", "g1f3"],
      sans: ["e4", "e5", "Nf3"],
      games: 1,
    };
    const survives = {
      ucis: ["d2d4", "d7d5", "c2c4"],
      sans: ["d4", "d5", "c4"],
      games: 3,
      share: 0.2,
    };
    const fenBeforeNoReply = fenAfterLine(["e2e4", "e7e5"]);
    const fenLeafNoReply = fenAfterLine(noReply.ucis);
    const evalMap = new Map([
      [fenBeforeNoReply, { score_cp: 10, best_move_uci: "g1f3" }],
      [fenLeafNoReply, { score_cp: 10, best_move_uci: null }],
      ...evalMapForLine(survives.ucis, OPP, { cpLoss: 40, bestUci: "e7e6" }),
    ]);
    const funnelOut = {};
    rankPrefilterCandidates([noReply, survives], evalMap, {
      fenAfterLine,
      oppColor: OPP,
      ancestorFreq: new Map([
        ...ancestorFreqForLine(noReply.ucis, 0.01),
        ...ancestorFreqForLine(survives.ucis, 0.12),
      ]),
      funnelOut,
    });
    expect(funnelOut.totalLines).toBe(2);
    expect(funnelOut.scored).toBe(1);
    expect(funnelOut.scoreDrops.noUserReply).toBe(1);
    expect(funnelOut.survived).toBe(1);
    expect(funnelOut.afterCollapse).toBe(1);
  });

  it("filters a line that clears no OR-gate: weak edge, no slip, no struggle, not off-modal", () => {
    // oppColor white, small cp-loss => userLeafAdvantage = cpLoss - 20 = -15 (< 20), cpLoss 5
    // (< 12), no annotated struggle/offModal => fails every survival condition.
    const gatedOut = {
      ucis: ["e2e4", "e7e5", "g1f3"],
      sans: ["e4", "e5", "Nf3"],
      games: 1,
      share: 0.01,
    };
    const evalMap = evalMapForLine(gatedOut.ucis, "white", { cpLoss: 5, bestUci: "b1c3" });
    const ranked = rankPrefilterCandidates([gatedOut], evalMap, {
      fenAfterLine,
      oppColor: "white",
      ancestorFreq: ancestorFreqForLine(gatedOut.ucis, 0.005),
    });
    expect(ranked).toHaveLength(0);
  });
});

describe("computePrefilterScopeKey", () => {
  it("keys readiness on username, speed, game-id hash, and scoring version", () => {
    const games = [
      { gameId: "b" },
      { gameId: "a" },
    ];
    const key = computePrefilterScopeKey({
      username: "Rival",
      activeSpeed: "blitz",
      games,
    });
    expect(key).toMatch(/^rival\|blitz\|\d+\|3$/);
    expect(
      computePrefilterScopeKey({ username: "rival", activeSpeed: "blitz", games }),
    ).toBe(key);
  });
});

describe("runStockfishPrefilter limits", () => {
  it("limits Maia to 12 unique branches from a 48-candidate ranked pool", () => {
    const ranked = Array.from({ length: SCOUT_PREFILTER_LIMIT }, (_, i) => ({
      line: { ucis: [`u${i}`], sans: [`m${i}`], line: `u${i}` },
      prefilterScore: SCOUT_PREFILTER_LIMIT - i,
    }));
    const maia = prefilterMaiaLines(ranked);
    expect(maia).toHaveLength(SCOUT_MAIA_PREFILTER_LIMIT);
    expect(new Set(maia.map((l) => l.line)).size).toBe(SCOUT_MAIA_PREFILTER_LIMIT);
  });

  it("prefilterPoolLines ranks the higher-prior line above a rare strong-edge line", () => {
    // Reproducibility now lives in the engine-free exploitabilityPrior (annotated upstream by
    // rankedOpeningBranches), not in the post-Stockfish rank. The reproducible main system
    // (high prior) must still outrank a rare line with a bigger raw leaf edge.
    const frequentWeak = {
      ucis: ["e2e4", "e7e5", "g1f3"],
      sans: ["e4", "e5", "Nf3"],
      games: 20,
      share: 0.8,
      exploitabilityPrior: 4,
    };
    const rareStrong = {
      ucis: ["d2d4", "d7d5", "c2c4"],
      sans: ["d4", "d5", "c4"],
      games: 1,
      share: 0.01,
      exploitabilityPrior: 0.5,
    };
    const evalMap = new Map([
      ...evalMapForLine(rareStrong.ucis, "white", { cpLoss: 50, bestUci: "e7e6" }),
      ...evalMapForLine(frequentWeak.ucis, "white", { cpLoss: 40, bestUci: "b8c6" }),
    ]);
    const ancestorFreq = new Map([
      [fenAfterLine(["d2d4", "d7d5"]), { count: 1, frequency: 0.01 }],
      [fenAfterLine(["e2e4", "e7e5"]), { count: 20, frequency: 0.1 }],
    ]);
    const ranked = rankPrefilterCandidates([frequentWeak, rareStrong], evalMap, {
      fenAfterLine,
      oppColor: "white",
      ancestorFreq,
    });
    const pool = prefilterPoolLines(ranked, 2);
    expect(pool[0].ucis).toEqual(frequentWeak.ucis);
    expect(pool[1].ucis).toEqual(rareStrong.ucis);
  });

  it("deduplicates a shared leaf FEN across branches", () => {
    const sharedLeaf = fenAfterLine(["e2e4", "e7e5", "g1f3"]);
    const cache = new Map([[prefilterCacheKey(sharedLeaf), { score_cp: 5, complete: true }]]);
    const lines = [
      { ucis: ["e2e4", "e7e5", "g1f3"], sans: ["e4", "e5", "Nf3"], games: 1 },
      { ucis: ["e2e4", "e7e5", "g1f3"], sans: ["e4", "e5", "Nf3"], games: 1 },
    ];
    const fens = collectPrefilterFens(lines, { fenAfterLine, oppColor: "white" });
    expect(fens.filter((f) => f === sharedLeaf)).toHaveLength(1);
    expect(fens).toHaveLength(1);
    expect(cache.has(prefilterCacheKey(sharedLeaf))).toBe(true);
  });
});

describe("buildFallbackPrefilterData", () => {
  it("builds ranked pool and display lines from opening-line order", () => {
    const lines = Array.from({ length: 70 }, (_, i) => ({
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

describe("rankPrefilterCandidates mate gates", () => {
  it("passes user-favourable mate lines even with cp=0 edge", () => {
    // Regression: mate lines have score_cp=null so prefilterScore=0, but mateIn > 0
    // must survive the OR gate. Before the fix, they failed all gates and were dropped.
    const mateInLine = {
      ucis: ["e2e4"],
      sans: ["e4"],
      games: 1,
      share: 0.01,
    };
    const fenLeaf = fenAfterLine(mateInLine.ucis);
    // Mate in 2 for black (user, oppColor=white), so mate_in = -2 (White-POV flipped).
    const evalMap = new Map([
      [fenLeaf, { score_cp: null, mate_in: -2, best_move_uci: null }],
    ]);
    const ranked = rankPrefilterCandidates([mateInLine], evalMap, {
      fenAfterLine,
      oppColor: "white",
      ancestorFreq: ancestorFreqForLine(mateInLine.ucis, 0.005),
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].mateIn).toBe(2);
  });

  it("does not pass opponent-mate lines even with a large cp edge", () => {
    // Opponent mate (white-favourable when user is black) should not survive.
    const oppMate = {
      ucis: ["e2e4"],
      sans: ["e4"],
      games: 1,
      share: 0.01,
    };
    const fenLeaf = fenAfterLine(oppMate.ucis);
    // Mate in 3 for white (opponent, when user is black), so mate_in = 3.
    const evalMap = new Map([
      [fenLeaf, { score_cp: 1000, mate_in: 3, best_move_uci: "e4e5" }],
    ]);
    const ranked = rankPrefilterCandidates([oppMate], evalMap, {
      fenAfterLine,
      oppColor: "white",
      ancestorFreq: new Map(),
    });
    expect(ranked).toHaveLength(0);
  });
});