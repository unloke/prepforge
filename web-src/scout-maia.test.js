import { describe, expect, it, vi } from "vitest";

import {
  MAIA_ENRICH_FAILED,
  MAIA_ENRICH_IDLE,
  MAIA_ENRICH_PARTIAL,
  MAIA_ENRICH_READY,
  clampMaiaRating,
  classifyMaiaEnrichState,
  isMaiaAttempted,
  isMaiaFailed,
  maiaScorePctFromWdl,
  medianOpponentRating,
  rememberMaiaResult,
  readLineMaiaWdl,
  buildGamePlanDisplayLines,
  rememberMaiaFailure,
  resetMaiaScopeCache,
  scoutLineWdlCounts,
  scoutMaiaRankedNote,
  wdlToOpponentPerspective,
} from "./scout-maia.js";
import { buildScoutSectionReport } from "./scout-report.js";
import * as scoutModule from "./scout.js";
describe("scout-maia helpers", () => {
  it("medianOpponentRating picks the middle game rating for a colour", () => {
    const games = [
      { color: "white", rating: 1600 },
      { color: "white", rating: 1800 },
      { color: "white", rating: 2000 },
      { color: "black", rating: 1500 },
    ];
    expect(medianOpponentRating(games, "white")).toBe(1800);
  });

  it("wdlToOpponentPerspective inverts when the user is to move", () => {
    const wdl = { win: 300, draw: 200, loss: 500 };
    expect(wdlToOpponentPerspective(wdl, true)).toEqual({ win: 500, draw: 200, loss: 300 });
    expect(wdlToOpponentPerspective(wdl, false)).toEqual(wdl);
  });

  it("maiaScorePctFromWdl matches win + half-draw permille", () => {
    expect(maiaScorePctFromWdl({ win: 400, draw: 200, loss: 400 })).toBe(50);
  });

  it("clampMaiaRating bounds to Maia's supported range", () => {
    expect(clampMaiaRating(400)).toBe(600);
    expect(clampMaiaRating(3000)).toBe(2600);
    expect(clampMaiaRating(1825)).toBe(1825);
  });
});

describe("readLineMaiaWdl", () => {
  it("records failure and does not retry provider reads on a second schedule", async () => {
    const provider = {
      wdlRead: vi.fn().mockRejectedValue(new Error("Maia down")),
    };
    const line = { ucis: ["d2d4"] };
    const fenAfterLine = () => "fen-after-d4";
    const maiaResults = new Map();
    const cache = new Map();
    const opts = {
      provider,
      rating: 1800,
      oppColor: "white",
      fenAfterLine,
      cache,
      maiaResults,
    };
    await readLineMaiaWdl(line, opts);
    await readLineMaiaWdl(line, opts);
    expect(provider.wdlRead).toHaveBeenCalledTimes(1);
    expect(isMaiaFailed(maiaResults, "fen-after-d4", 1800)).toBe(true);
    expect(isMaiaAttempted(maiaResults, "fen-after-d4", 1800)).toBe(true);
  });

  it("uses wdlRead not positionRead — policy post-processing cannot kill the WDL read", async () => {
    const provider = {
      wdlRead: vi.fn().mockResolvedValue({ wdl: { win: 500, draw: 200, loss: 300 } }),
      positionRead: vi.fn().mockRejectedValue(new Error("legalMoveIndices: vocab drift")),
    };
    const result = await readLineMaiaWdl({ ucis: ["d2d4", "g8f6", "c2c4"] }, {
      provider,
      rating: 1800,
      oppColor: "white",
      fenAfterLine: () => "fen-complex",
      cache: new Map(),
      maiaResults: new Map(),
    });
    expect(provider.wdlRead).toHaveBeenCalledTimes(1);
    expect(provider.positionRead).not.toHaveBeenCalled();
    expect(result?.maiaScorePct).toBeDefined();
  });

  it("retries a legacy positionRead failure (no method tag) via wdlRead", async () => {
    const provider = {
      wdlRead: vi.fn().mockResolvedValue({ wdl: { win: 200, draw: 300, loss: 500 } }),
    };
    const maiaResults = new Map([["1800|fen-after-d4", { failed: true }]]);
    const line = { ucis: ["d2d4"] };
    const result = await readLineMaiaWdl(line, {
      provider,
      rating: 1800,
      oppColor: "white",
      fenAfterLine: () => "fen-after-d4",
      cache: new Map(),
      maiaResults,
    });
    expect(provider.wdlRead).toHaveBeenCalledTimes(1);
    expect(result?.maiaScorePct).toBeDefined();
    expect(isMaiaFailed(maiaResults, "fen-after-d4", 1800)).toBe(false);
    expect(isMaiaAttempted(maiaResults, "fen-after-d4", 1800)).toBe(true);
  });

  it("memoizes provider reads per fen and rating", async () => {
    const provider = {
      wdlRead: vi.fn().mockResolvedValue({
        wdl: { win: 200, draw: 300, loss: 500 },
      }),
    };
    const line = { ucis: ["d2d4"] };
    const fenAfterLine = () => "fen-after-d4";
    const cache = new Map();
    const first = await readLineMaiaWdl(line, {
      provider,
      rating: 1800,
      oppColor: "white",
      fenAfterLine,
      cache,
    });
    const second = await readLineMaiaWdl(line, {
      provider,
      rating: 1800,
      oppColor: "white",
      fenAfterLine,
      cache,
    });
    expect(provider.wdlRead).toHaveBeenCalledTimes(1);
    expect(first?.maiaScorePct).toBe(second?.maiaScorePct);
    expect(first?.maiaWdl).toEqual({ win: 500, draw: 300, loss: 200 });
    expect(first?.maiaScorePct).toBe(65);
  });
});

describe("buildGamePlanDisplayLines", () => {
  it("includes Maia-successful backup lines beyond the Stockfish top 12", () => {
    const stockfishDisplay = Array.from({ length: 12 }, (_, i) => ({
      ucis: [`s${i}`],
      sans: [`s${i}`],
      games: 1,
      line: `s${i}`,
    }));
    const backup = { ucis: ["backup"], sans: ["backup"], games: 1, line: "backup" };
    const rankedEntries = [
      ...stockfishDisplay.map((line) => ({ line, prefilterScore: 100 - Number(line.ucis[0].slice(1)) })),
      { line: backup, prefilterScore: 1 },
    ];
    const maiaResults = new Map();
    const fenAfterLine = (ucis) => `fen-${ucis[0]}`;
    rememberMaiaResult(maiaResults, fenAfterLine(backup.ucis), 1800, {
      maiaWdl: { win: 100, draw: 100, loss: 800 },
      maiaScorePct: 40,
    });
    for (const line of stockfishDisplay) {
      rememberMaiaFailure(maiaResults, fenAfterLine(line.ucis), 1800);
    }

    const display = buildGamePlanDisplayLines({
      rankedEntries,
      stockfishDisplayLines: stockfishDisplay,
      maiaResults,
      rating: 1800,
      fenAfterLine,
    });

    expect(display.some((line) => line.ucis[0] === "backup")).toBe(true);
    expect(display).toHaveLength(13);
  });
});

describe("enrichGlobalMaiaPool", () => {
  it("ranks candidates globally so a higher black score wins over white", async () => {
    const { enrichGlobalMaiaPool } = await import("./scout-maia.js");
    const calls = [];
    const provider = {
      wdlRead: vi.fn(({ fen }) => {
        calls.push(fen);
        return Promise.resolve({ wdl: { win: 200, draw: 200, loss: 600 } });
      }),
    };
    const { mergeGlobalPrefilterRanked } = await import("./scout-prefilter.js");
    const entries = mergeGlobalPrefilterRanked({
      white: [{ line: { ucis: ["w1"], sans: ["w1"], games: 1 }, prefilterScore: 10, hasUserReply: true }],
      black: [{ line: { ucis: ["b1"], sans: ["b1"], games: 1 }, prefilterScore: 50, hasUserReply: true }],
    });
    await enrichGlobalMaiaPool(entries, {
      successTarget: 1,
      provider,
      fenAfterLine: (ucis) => `fen-${ucis[0]}`,
      getRating: () => 1800,
      getBaselineScorePct: () => 50,
      maiaResults: new Map(),
    });
    expect(calls[0]).toBe("fen-b1");
  });

  it("reads every recommendation of both colours, not 12 in total", async () => {
    const { enrichGlobalMaiaPool, countGlobalMaiaOutcomes, globalMaiaPoolNeedsWork } =
      await import("./scout-maia.js");
    // White routes outrank every black route, so a shared 12-read budget would
    // spend it all on white and leave the 12 black recommendations without Maia.
    const entries = [
      ...Array.from({ length: 12 }, (_, i) => ({
        oppColor: "white",
        line: { ucis: [`w${i}`], sans: [`w${i}`], games: 1 },
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        oppColor: "black",
        line: { ucis: [`b${i}`], sans: [`b${i}`], games: 1 },
      })),
    ];
    const provider = {
      wdlRead: vi.fn(() => Promise.resolve({ wdl: { win: 200, draw: 200, loss: 600 } })),
    };
    const maiaResults = new Map();
    const context = {
      maiaResults,
      getRating: () => 1800,
      fenAfterLine: (ucis) => `fen-${ucis[0]}`,
    };
    const progress = [];
    const { successesByColor } = await enrichGlobalMaiaPool(entries, {
      ...context,
      provider,
      getBaselineScorePct: () => 50,
      onProgress: (p) => progress.push(p),
    });
    expect(successesByColor.white).toHaveLength(12);
    expect(successesByColor.black).toHaveLength(12);
    expect(progress.at(-1)).toMatchObject({ done: 24, total: 24 });
    expect(countGlobalMaiaOutcomes(entries, context)).toMatchObject({
      resolved: 24, missing: 0, expected: 24,
    });
    expect(globalMaiaPoolNeedsWork(entries, { ...context, attemptsUsed: 24 })).toBe(false);
  });

  it("can still reach successTarget after failures consume extra attempts", async () => {
    const { enrichGlobalMaiaPool, SCOUT_MAIA_SUCCESS_TARGET } = await import("./scout-maia.js");
    const entries = Array.from({ length: 14 }, (_, i) => ({
      oppColor: i % 2 === 0 ? "white" : "black",
      line: { ucis: [`m${i}`], sans: [`m${i}`], games: 1 },
      prefilterScore: 100 - i,
    }));
    const provider = {
      wdlRead: vi.fn(({ fen }) => {
        if (fen === "fen-m1" || fen === "fen-m3") return Promise.reject(new Error("fail"));
        return Promise.resolve({ wdl: { win: 100, draw: 100, loss: 800 } });
      }),
    };
    const { successes, attempts } = await enrichGlobalMaiaPool(entries, {
      successTarget: SCOUT_MAIA_SUCCESS_TARGET,
      provider,
      fenAfterLine: (ucis) => `fen-${ucis[0]}`,
      getRating: () => 1800,
      getBaselineScorePct: () => 50,
      maiaResults: new Map(),
    });
    expect(successes).toHaveLength(SCOUT_MAIA_SUCCESS_TARGET);
    expect(attempts).toBeGreaterThan(SCOUT_MAIA_SUCCESS_TARGET);
  });
});

describe("scoutLineWdlCounts", () => {
  it("reads Maia permille keys for bar rendering", () => {
    expect(
      scoutLineWdlCounts({ maiaWdl: { win: 300, draw: 200, loss: 500 } }),
    ).toEqual({ w: 300, d: 200, l: 500 });
  });
});

describe("classifyMaiaEnrichState", () => {
  it("treats resolved + failed as complete", () => {
    expect(classifyMaiaEnrichState({ resolved: 2, failed: 0, expected: 2 })).toBe(
      MAIA_ENRICH_READY,
    );
    expect(classifyMaiaEnrichState({ resolved: 0, failed: 2, expected: 2 })).toBe(
      MAIA_ENRICH_FAILED,
    );
    expect(classifyMaiaEnrichState({ resolved: 1, failed: 1, expected: 2 })).toBe(
      MAIA_ENRICH_PARTIAL,
    );
  });
});

describe("resetMaiaScopeCache", () => {
  it("prunes only failures when scope changes and keeps successful reads", () => {
    const successFen = "fen-success";
    const failFen = "fen-fail";
    const maiaCache = new Map([
      ["wdlRead|1800|fen-success", Promise.resolve({ wdl: { win: 1, draw: 0, loss: 0 } })],
      ["wdlRead|1800|fen-fail", Promise.resolve(null)],
      ["other-key", Promise.resolve(null)],
    ]);
    const state = {
      maiaScopeKey: "all|10|1800|1750",
      maiaResults: new Map([
        [`1800|${successFen}`, { maiaWdl: { win: 400, draw: 200, loss: 400 }, maiaScorePct: 50 }],
        [`1800|${failFen}`, { failed: true }],
      ]),
      maiaCache,
      maiaEnrichState: MAIA_ENRICH_PARTIAL,
    };
    resetMaiaScopeCache(state, "all|11|1800|1750");
    expect(state.maiaResults.size).toBe(1);
    expect(state.maiaResults.get(`1800|${successFen}`)?.maiaScorePct).toBe(50);
    expect(state.maiaResults.has(`1800|${failFen}`)).toBe(false);
    expect(maiaCache.has("wdlRead|1800|fen-success")).toBe(true);
    expect(maiaCache.has("wdlRead|1800|fen-fail")).toBe(false);
    expect(maiaCache.has("other-key")).toBe(true);
    expect(state.maiaEnrichState).toBe(MAIA_ENRICH_IDLE);
  });

  it("preserves enrich state when scope changes but no failures were pruned", () => {
    const state = {
      maiaScopeKey: "all|10|1800|1750",
      maiaResults: new Map([
        ["1800|fen", { maiaWdl: { win: 500, draw: 0, loss: 500 }, maiaScorePct: 50 }],
      ]),
      maiaCache: new Map(),
      maiaEnrichState: MAIA_ENRICH_READY,
    };
    resetMaiaScopeCache(state, "all|11|1800|1750");
    expect(state.maiaResults.size).toBe(1);
    expect(state.maiaEnrichState).toBe(MAIA_ENRICH_READY);
  });
});

describe("scoutMaiaRankedNote", () => {
  it("leaves loading feedback to the shared inline state", () => {
    expect(scoutMaiaRankedNote([{ scorePct: 50 }], "loading")).toBe("");
    expect(scoutMaiaRankedNote([{ scorePct: 50 }], "idle", { prefilterState: "loading" })).toBe("");
    expect(scoutMaiaRankedNote([{ scorePct: 50 }], "maia-off")).toBe("");
    expect(scoutMaiaRankedNote([{ scorePct: 50 }], "loading")).not.toContain(
      "score/WDL are Maia estimates",
    );
  });

  // Settled states carry no standing explanation of how the list is ranked.
  it("keeps failures actionable and omits ranking explanations once reads settle", () => {
    expect(scoutMaiaRankedNote([{ scorePct: 50 }], MAIA_ENRICH_FAILED)).toContain("Maia unavailable on 1/1 lines. Retry in Settings");
    expect(
      scoutMaiaRankedNote([{ maiaScorePct: 40, scorePct: 40 }, { scorePct: 55 }], MAIA_ENRICH_PARTIAL),
    ).toContain("Maia unavailable on 1/2 lines.");
    expect(scoutMaiaRankedNote([{ maiaScorePct: 40, scorePct: 40 }], "done")).toBe("");
  });
});

describe("Maia failure UI", () => {
  function escapeHtml(value) {
    return String(value);
  }

  const PLAN_GAMES = [
    {
      color: "white",
      score: 1,
      sans: ["e4", "c5", "Nf3"],
      ucis: ["e2e4", "c7c5", "g1f3"],
      rating: 1800,
      datestamp: 3000,
      speed: "blitz",
    },
  ];

  it("renders unavailable note when all cached leaves failed", () => {
    const maiaResults = new Map();
    const fen = scoutModule.fenAfterLine(["e2e4", "c7c5", "g1f3"]);
    maiaResults.set(`1800|${fen}`, { failed: true });
    const { html } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        username: "rival",
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      [],
      {
        speedFilter: "all",
        escapeHtml,
        maiaResults,
        maiaRatings: { white: 1800, black: 1800 },
        maiaEnrichState: MAIA_ENRICH_FAILED,
      },
    );
    expect(html).not.toContain("scout-maia-estimate");
    expect(html).toContain("No reachable weak spots in these games");
    expect(html).not.toContain("Evaluating");
  });
});
