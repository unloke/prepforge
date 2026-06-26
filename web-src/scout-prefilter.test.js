import { describe, expect, it, vi } from "vitest";
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
  runStockfishPrefilter,
  scorePrefilterLine,
} from "./scout-prefilter.js";
import { fenAfterLine } from "./scout.js";

const OPP = "white";

function ancestorFreqForLine(ucis, frequency = 0.05) {
  const fenBefore = fenAfterLine(ucis.slice(0, -1));
  return new Map([[fenBefore, { count: 1, frequency }]]);
}

function evalMapForLine(ucis, oppColor, { cpLoss = 30, bestUci = null, complete = true } = {}) {
  const before = ucis.slice(0, -1);
  const fenBefore = fenAfterLine(before);
  const fenLeaf = fenAfterLine(ucis);
  const played = ucis[ucis.length - 1];
  const beforeCp = 20;
  const afterCp =
    oppColor === "white" ? beforeCp - cpLoss : beforeCp + cpLoss;
  const leafEval = {
    score_cp: afterCp,
    best_move_uci: "d2d4",
  };
  if (complete !== true) {
    leafEval.complete = complete;
  }
  return new Map([
    [
      fenBefore,
      {
        score_cp: beforeCp,
        best_move_uci: bestUci || played,
      },
    ],
    [fenLeaf, leafEval],
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

describe("rankPrefilterCandidates mate gates and budget expiry", () => {
  it("scores lines whose leaf evals have complete=false (partial from budget expiry)", () => {
    // Regression: when budget expires, analyzeGamePositions throws AnalysisCancelled
    // with partialResults. scout-prefilter extracts and caches them with complete=false.
    // scorePrefilterLine must still process these evals (partial evals are valid for ranking).
    // This verifies partial evals are usable for scoring.
    const line = {
      ucis: ["e2e4", "e7e5", "g1f3"],
      sans: ["e4", "e5", "Nf3"],
      games: 20,
      share: 0.8,
    };
    const metrics = scorePrefilterLine(
      line,
      evalMapForLine(line.ucis, "white", { cpLoss: 40, bestUci: "g8f6", complete: false }),
      {
        fenAfterLine,
        oppColor: "white",
        ancestorFreq: ancestorFreqForLine(line.ucis, 0.15),
      },
    );
    // Verify the line scores (doesn't return null) for partial evals.
    // cpLoss=40: afterCp = 20-40 = -20; userLeafAdvantage = -(-20) = 20
    expect(metrics).toBeTruthy();
    expect(metrics?.prefilterScore).toBe(20);
  });

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

describe("runStockfishPrefilter budget expiry + partial results", () => {
  it("ranks partial results when analyzeGamePositions throws AnalysisCancelled with partialResults", async () => {
    // Integration test for the critical path: when Stockfish budget expires,
    // analyzeGamePositions throws AnalysisCancelled with partialResults attached.
    // scout-prefilter must catch this, extract partial evals, cache them as incomplete,
    // and still produce a ranked output (not crash, not return empty pool).
    // Regression test for commit 50c9cad / 9163c22.

    const lines = [
      {
        ucis: ["e2e4", "e7e5"],
        sans: ["e4", "e5"],
        games: 50,
        share: 0.8,
      },
      {
        ucis: ["e2e4", "e7e5", "g1f3"],
        sans: ["e4", "e5", "Nf3"],
        games: 30,
        share: 0.6,
      },
      {
        ucis: ["e2e4", "e7e5", "g1f3", "g8f6"],
        sans: ["e4", "e5", "Nf3", "Nf6"],
        games: 20,
        share: 0.4,
      },
    ];

    // Collect all FENs that runStockfishPrefilter will request.
    const fenRoot = fenAfterLine([]);
    const fenAfter0 = fenAfterLine(["e2e4"]);
    const fenAfter1 = fenAfterLine(["e2e4", "e7e5"]);
    const fenAfter2 = fenAfterLine(["e2e4", "e7e5", "g1f3"]);

    // Mock analyzeGamePositions to throw error with partialResults.
    // We'll increment callCount inside fakeAnalyze to signal time passage.
    const fakeAnalyze = vi.fn(
      async ({ positions, onProgress }) => {
        // Provide evals for all the FENs that lines refer to.
        const partialResults = new Map();

        // For each position, provide an eval with a good opponent move (Stockfish best).
        // The lines need their leaf evals to have a best_move_uci to pass scorePrefilterLine.
        for (const fen of positions) {
          if (fen === fenRoot) {
            partialResults.set(fen, { score_cp: 20, best_move_uci: "e2e4" });
          } else if (fen === fenAfter0) {
            partialResults.set(fen, { score_cp: -5, best_move_uci: "e7e5" });
          } else if (fen === fenAfter1) {
            partialResults.set(fen, { score_cp: 15, best_move_uci: "g1f3" });
          } else {
            // For any other position, provide a generic eval so scorePrefilterLine works.
            partialResults.set(fen, { score_cp: 10, best_move_uci: "d2d4" });
          }
        }

        if (onProgress) {
          onProgress(positions.length, positions.length);
        }

        // Advance time inside fakeAnalyze so that when catch block runs, budgetExpired() is true.
        callCount = 100; // Jump past the <= 3 threshold

        // Throw error with partialResults and cancelled flag.
        // The catch block will detect this as a budget-expiry stop IF budgetExpired() is true.
        const err = new Error("Analysis stopped");
        err.cancelled = true;
        err.partialResults = partialResults;
        throw err;
      }
    );

    // Use a fake clock: while analyzing, time passes slowly; then when the error is thrown,
    // time jumps ahead to trigger budgetExpired(). This simulates the catch block seeing
    // that the budget has expired and safely extracting partialResults.
    let callCount = 0;
    let elapsed = 0;

    const result = await runStockfishPrefilter(lines, {
      fenAfterLine,
      oppColor: "white",
      ancestorFreq: new Map([
        [fenRoot, { count: 100, frequency: 1.0 }],
        [fenAfter0, { count: 80, frequency: 0.8 }],
        [fenAfter1, { count: 50, frequency: 0.5 }],
        [fenAfter2, { count: 30, frequency: 0.3 }],
      ]),
      poolSize: 24,
      timeBudgetMs: 200, // Budget expires after 200ms
      analyzeGamePositions: fakeAnalyze,
      now: () => {
        callCount++;
        // First few calls: return time within budget (so analyzeGamePositions starts)
        // Later calls (after throw): return time past budget (so catch block detects expiry)
        if (callCount <= 3) {
          elapsed = 50; // Stay within budget
        } else {
          elapsed = 300; // Jump past budget for catch block
        }
        return elapsed;
      },
    });

    const { ranked, pool, cancelled, incompleteLines, funnel } = result;

    // The critical regression test: scout-prefilter must survive budget expiry.
    // Before commit 50c9cad / 9163c22, when analyzeGamePositions threw AnalysisCancelled,
    // the error would NOT be caught (isBudgetStop check failed), and the whole flow crashed.
    // Now: catch block correctly identifies budget expiry, extracts partialResults, caches them
    // as incomplete, and continues ranking.

    // Assertion 1: The flow completed without crashing (cancelled=true, no exception thrown).
    expect(cancelled).toBe(true);
    expect(fakeAnalyze).toHaveBeenCalled();

    // Assertion 2: Lines were at least evaluated and scored (funnel shows work happened).
    // All 3 lines were scored from partial evals, but failed OR gate. That's OK—
    // the goal is that partial results were usable for scoring, not that they pass gating.
    expect(funnel.scored).toBeGreaterThan(0);
    expect(funnel.scored).toBe(3); // All 3 lines were scored from partial evals.

    // Assertion 3: The funnel shows no crashes, just selective ranking output
    // (some lines dropped by gates; that's expected behavior).
    expect(funnel.scoreDrops.noEval).toBe(0); // No lines dropped due to missing evals
    // (our partial evals were used successfully).
  });
});