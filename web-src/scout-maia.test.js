import { describe, expect, it, vi } from "vitest";

import {
  MAIA_ENRICH_FAILED,
  MAIA_ENRICH_IDLE,
  MAIA_ENRICH_PARTIAL,
  MAIA_ENRICH_READY,
  clampMaiaRating,
  classifyMaiaEnrichState,
  enrichOpeningLinesWithMaia,
  isMaiaAttempted,
  isMaiaFailed,
  maiaScorePctFromWdl,
  medianOpponentRating,
  rememberMaiaResult,
  readLineMaiaWdl,
  getCachedMaiaResult,
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
      positionRead: vi.fn().mockRejectedValue(new Error("Maia down")),
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
    expect(provider.positionRead).toHaveBeenCalledTimes(1);
    expect(isMaiaFailed(maiaResults, "fen-after-d4", 1800)).toBe(true);
    expect(isMaiaAttempted(maiaResults, "fen-after-d4", 1800)).toBe(true);
  });

  it("memoizes provider reads per fen and rating", async () => {
    const provider = {
      positionRead: vi.fn().mockResolvedValue({
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
    expect(provider.positionRead).toHaveBeenCalledTimes(1);
    expect(first?.maiaScorePct).toBe(second?.maiaScorePct);
    expect(first?.maiaWdl).toEqual({ win: 500, draw: 300, loss: 200 });
    expect(first?.maiaScorePct).toBe(65);
  });
});

describe("enrichOpeningLinesWithMaia", () => {
  it("does not increase positionRead calls when enrichment is scheduled twice after failures", async () => {
    const provider = {
      positionRead: vi.fn().mockRejectedValue(new Error("Maia down")),
    };
    const lines = [
      { ucis: ["d2d4"], sans: ["d4"], games: 5, scorePct: 70, share: 0.2, w: 3, d: 1, l: 1 },
    ];
    const maiaResults = new Map();
    const common = {
      provider,
      rating: 1800,
      oppColor: "white",
      baselineScorePct: 55,
      fenAfterLine: () => "fen",
      maiaResults,
      cache: new Map(),
    };
    await enrichOpeningLinesWithMaia(lines, common);
    await enrichOpeningLinesWithMaia(lines, common);
    expect(provider.positionRead).toHaveBeenCalledTimes(1);
    expect(isMaiaFailed(maiaResults, "fen", 1800)).toBe(true);
  });

  it("enriches lines with Maia WDL and re-badges from Maia score", async () => {
    const provider = {
      positionRead: vi.fn().mockResolvedValue({
        wdl: { win: 100, draw: 100, loss: 800 },
      }),
    };
    const lines = [
      {
        ucis: ["d2d4"],
        sans: ["d4"],
        games: 5,
        scorePct: 70,
        share: 0.2,
        w: 3,
        d: 1,
        l: 1,
      },
    ];
    const maiaResults = new Map();
    const enriched = await enrichOpeningLinesWithMaia(lines, {
      provider,
      rating: 1800,
      oppColor: "white",
      baselineScorePct: 55,
      fenAfterLine: () => "fen",
      maiaResults,
    });
    expect(enriched[0].maiaScorePct).toBe(85);
    expect(enriched[0].prepCategory).toBe("weapon");
    expect(maiaResults.size).toBe(1);
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
      ["positionRead|1800|fen-success", Promise.resolve({ wdl: { win: 1, draw: 0, loss: 0 } })],
      ["positionRead|1800|fen-fail", Promise.resolve(null)],
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
    expect(maiaCache.has("positionRead|1800|fen-success")).toBe(true);
    expect(maiaCache.has("positionRead|1800|fen-fail")).toBe(false);
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

describe("scope change streaming", () => {
  it("does not re-call positionRead for successful FENs after gameCount changes", async () => {
    const provider = {
      positionRead: vi.fn().mockImplementation(({ fen }) => {
        if (fen === "fen-ok") {
          return Promise.resolve({ wdl: { win: 200, draw: 200, loss: 600 } });
        }
        return Promise.reject(new Error("still failing"));
      }),
    };
    const maiaResults = new Map();
    const maiaCache = new Map();
    const state = {
      maiaScopeKey: "all|5|1800|1750",
      maiaResults,
      maiaCache,
      maiaEnrichState: MAIA_ENRICH_PARTIAL,
    };
    const okLine = {
      ucis: ["e2e4"],
      sans: ["e4"],
      games: 5,
      scorePct: 60,
      share: 0.5,
      w: 3,
      d: 0,
      l: 2,
    };
    const failLine = {
      ucis: ["d2d4"],
      sans: ["d4"],
      games: 3,
      scorePct: 40,
      share: 0.3,
      w: 1,
      d: 0,
      l: 2,
    };
    const common = {
      provider,
      rating: 1800,
      oppColor: "white",
      baselineScorePct: 50,
      fenAfterLine: (ucis) => (ucis[0] === "e2e4" ? "fen-ok" : "fen-bad"),
      maiaResults,
      cache: maiaCache,
    };
    await enrichOpeningLinesWithMaia([okLine, failLine], common);
    expect(provider.positionRead).toHaveBeenCalledTimes(2);

    resetMaiaScopeCache(state, "all|6|1800|1750");

    provider.positionRead.mockClear();
    await enrichOpeningLinesWithMaia([okLine, failLine], common);
    expect(provider.positionRead).toHaveBeenCalledTimes(1);
    expect(provider.positionRead).toHaveBeenCalledWith(
      expect.objectContaining({ fen: "fen-bad", rating: 1800 }),
    );
    expect(getCachedMaiaResult(maiaResults, "fen-ok", 1800)?.maiaScorePct).toBe(70);
  });
});

describe("scoutMaiaRankedNote", () => {
  it("shows loading copy before Maia results arrive", () => {
    expect(scoutMaiaRankedNote([{ scorePct: 50 }], "loading")).toContain("loading");
    expect(scoutMaiaRankedNote([{ scorePct: 50 }], "loading")).not.toContain(
      "score/WDL are Maia estimates",
    );
  });

  it("shows unavailable after all Maia reads fail", () => {
    const note = scoutMaiaRankedNote([{ scorePct: 50 }], MAIA_ENRICH_FAILED);
    expect(note).toContain("Maia unavailable");
    expect(note).not.toContain("loading");
  });

  it("shows partial fallback when some lines have Maia", () => {
    const note = scoutMaiaRankedNote(
      [{ maiaScorePct: 40, scorePct: 40 }, { scorePct: 55 }],
      MAIA_ENRICH_PARTIAL,
    );
    expect(note).toContain("partial Maia estimates");
    expect(note).not.toContain("loading");
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
    expect(html).toContain("Maia unavailable");
    expect(html).not.toContain("Maia estimates loading");
  });
});