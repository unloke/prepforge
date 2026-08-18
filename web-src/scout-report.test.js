import { describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";

import * as scoutModule from "./scout.js";
import {
  buildScoutAnalyzePgn,
  buildScoutSectionReport,
  captureScoutExpanded,
  consumeEcoCacheEntry,
  handleScoutProfileClick,
  handleScoutResultsClick,
  renderScoutEnginePanel,
  renderScoutRefutationPanel,
  renderInlineRefutationCard,
  handleScoutRefutationGapClick,
  legalScoutLineSans,
  refutationA11ySummary,
  renderScoutProfile,
  restoreScoutExpanded,
  scoutLineDetailHtml,
  scoutRouteReasonText,
  scoutLineKey,
  scoutSparkline,
  scoutSvgBar,
  scoutScoreCell,
  scoutWdlBar,
  scoutLineWdlCounts,
  patchScoutLineMaiaCells,
  buildScoutIntelligenceA11ySummary,
} from "./scout-report.js";
import {
  MAIA_ENRICH_LOADING,
  MAIA_ENRICH_READY,
  rememberMaiaResult,
} from "./scout-maia.js";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoutGameRecord(game) {
  const ucis = game.ucis || [];
  return {
    opponentRating: 1700,
    openingUcis: ucis,
    openingSans: game.sans || [],
    openingEndPly: ucis.length,
    totalPly: ucis.length,
    clockAfterPly: ucis.map(() => null),
    timeControl: null,
    nextOwnThinkSeconds: [],
    ...game,
  };
}

const GAMES = [
  scoutGameRecord({
    color: "white",
    score: 1,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    rating: 1800,
    datestamp: 3000,
    speed: "blitz",
  }),
  scoutGameRecord({
    color: "white",
    score: 0,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    rating: 1800,
    datestamp: 2000,
    speed: "blitz",
  }),
  scoutGameRecord({
    color: "white",
    score: 1,
    sans: ["d4", "d5"],
    ucis: ["d2d4", "d7d5"],
    rating: 1800,
    datestamp: 1000,
    speed: "blitz",
  }),
];

const PLAN_GAMES = [
  ...Array.from({ length: 8 }, (_, i) =>
    scoutGameRecord({
      color: "white",
      score: i % 3 === 0 ? 1 : 0,
      sans: ["e4", "c5", "Nf3"],
      ucis: ["e2e4", "c7c5", "g1f3"],
      rating: 1800,
      datestamp: 4000 - i * 100,
      speed: "blitz",
      gameId: `sicilian-${i}`,
    }),
  ),
  ...Array.from({ length: 7 }, (_, i) =>
    scoutGameRecord({
      color: "white",
      score: i % 2 === 0 ? 1 : 0,
      sans: ["d4", "d5", "c4"],
      ucis: ["d2d4", "d7d5", "c2c4"],
      rating: 1800,
      datestamp: 3000 - i * 100,
      speed: "blitz",
      gameId: `london-${i}`,
    }),
  ),
];

const LOOKUPS = {
  white: [],
  black: [
    {
      rep: { id: "rep-black", name: "Sicilian" },
      lookup: scoutModule.repertoireChildLookup([
        { id: "root", depth: 0, parent_id: null, uci: null },
        { id: "n1", depth: 1, parent_id: "root", uci: "e2e4" },
      ]),
    },
  ],
};

function createStubElement(tag = "div") {
  const classes = new Set();
  const attrs = {};
  const el = {
    tagName: tag.toUpperCase(),
    innerHTML: "",
    dataset: {},
    nextElementSibling: null,
    get className() {
      return [...classes].join(" ");
    },
    set className(value) {
      classes.clear();
      for (const c of String(value || "").split(/\s+/)) {
        if (c) classes.add(c);
      }
    },
    classList: {
      add(c) {
        classes.add(c);
      },
      remove(c) {
        classes.delete(c);
      },
      toggle(c) {
        if (classes.has(c)) {
          classes.delete(c);
          return false;
        }
        classes.add(c);
        return true;
      },
      contains: (c) => classes.has(c),
    },
    setAttribute(name, value) {
      attrs[name] = value;
    },
    getAttribute(name) {
      return attrs[name];
    },
    closest(selector) {
      let node = el;
      while (node) {
        if (node.matches?.(selector)) return node;
        node = node.parent;
      }
      return null;
    },
    matches(selector) {
      if (selector === ".scout-line") return classes.has("scout-line");
      if (selector === ".scout-speed-chip") return classes.has("scout-speed-chip");
      if (selector === ".scout-action-analyze") return classes.has("scout-action-analyze");
      if (selector === ".scout-action-prep") return classes.has("scout-action-prep");
      if (selector === ".scout-action-add-prep") return classes.has("scout-action-add-prep");
      if (selector === ".scout-prepare-all") return classes.has("scout-prepare-all");
      if (selector === ".scout-badge") return classes.has("scout-badge");
      if (selector.startsWith("[data-prep-rep]")) return !!el.dataset.prepRep;
      return false;
    },
    querySelector(selector) {
      if (selector === ".scout-action-analyze") return el._analyzeBtn || null;
      if (selector === ".scout-action-prep") return el._prepBtn || null;
      if (selector === ".scout-miniboard") return el._miniboard || null;
      return null;
    },
    insertAdjacentElement(_pos, child) {
      child.parent = el;
      el.nextElementSibling = child;
      child.previousElementSibling = el;
      return child;
    },
    parent: null,
    previousElementSibling: null,
  };
  return el;
}

function stubFromHtml(html) {
  const root = createStubElement("div");
  if (html.includes('class="scout-speed-chip"') && html.includes('data-speed="blitz"')) {
    const chip = createStubElement("button");
    chip.classList.add("scout-speed-chip");
    chip.dataset.speed = "blitz";
    root._chip = chip;
    root.querySelector = (sel) => (sel === '[data-speed="blitz"]' ? chip : null);
  }
  return root;
}

function stubLineFromReport(html) {
  const lineEl = createStubElement("div");
  lineEl.classList.add("scout-line");
  lineEl.dataset.rowIdx = "0";
  lineEl.dataset.rowKind = "line";
  lineEl.dataset.color = "white";

  const prepAll = createStubElement("button");
  prepAll.classList.add("scout-prepare-all");
  prepAll.dataset.color = "white";

  const container = createStubElement("div");
  container._line = lineEl;
  container._prepAll = prepAll;
  container.querySelector = (sel) => {
    if (sel === ".scout-line") return lineEl;
    if (sel === ".scout-prepare-all") return prepAll;
    return null;
  };
  container.closest = (sel) => (sel === ".scout-section" ? container : null);
  container.dataset.scoutColor = "white";
  return { container, lineEl, prepAll };
}

describe("consumeEcoCacheEntry", () => {
  it("returns null for rejected promises without throwing", async () => {
    await expect(consumeEcoCacheEntry(Promise.reject(new Error("explorer down")))).resolves.toBeNull();
  });

  it("resolves string cache entries synchronously", async () => {
    await expect(consumeEcoCacheEntry("B90 Sicilian")).resolves.toBe("B90 Sicilian");
  });
});

describe("captureScoutExpanded / restoreScoutExpanded", () => {
  it("does not leave unhandled rejections for cached ECO promises", async () => {
    const { sectionData } = buildScoutSectionReport(
      scoutModule,
      {
        games: GAMES,
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    const line = sectionData.prepTargets?.[0] || sectionData.gradedLines[0];
    const key = scoutLineKey(line.ucis);
    const lineEl = createStubElement("div");
    lineEl.classList.add("scout-line");
    lineEl.dataset.lineKey = key;
    lineEl.dataset.color = "white";
    lineEl.dataset.rowIdx = "0";
    lineEl.dataset.rowKind = "line";
    const ecoEl = createStubElement("span");
    ecoEl.classList.add("scout-line-eco");
    lineEl.querySelector = (sel) => (sel === ".scout-line-eco" ? ecoEl : null);

    const results = createStubElement("div");
    results._lines = [lineEl];
    results.querySelectorAll = (sel) =>
      sel === ".scout-line[data-line-key]" ? results._lines : [];

    const rejected = Promise.reject(new Error("offline"));
    rejected.catch(() => {});

    await expect(
      Promise.resolve(
        restoreScoutExpanded(
          results,
          { white: sectionData },
          { expandedKeys: new Set([key]), scrollTop: 0 },
          {
            scoutModule,
            escapeHtml,
            ecoCache: new Map([[key, rejected]]),
            createElement: createStubElement,
            callbacks: {
              scoutLineDetailHtml: () => "",
              enrichEcoForLine: vi.fn(),
            },
          },
        ),
      ),
    ).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(ecoEl.textContent ?? "").toBe("");
  });
  it("captures expanded line keys by uci path, not row index", () => {
    const results = createStubElement("div");
    const line = createStubElement("div");
    line.classList.add("scout-line", "is-expanded");
    line.dataset.lineKey = "e2e4>c7c5>g1f3";
    results._lines = [line];
    results.querySelectorAll = (sel) => {
      if (sel === ".scout-line.is-expanded[data-line-key]") return results._lines;
      if (sel === ".scout-line[data-line-key]") return results._lines;
      return [];
    };
    results.scrollTop = 120;
    const captured = captureScoutExpanded(results);
    expect(captured.expandedKeys.has("e2e4>c7c5>g1f3")).toBe(true);
    expect(captured.scrollTop).toBe(120);
    expect(scoutLineKey(["e2e4", "c7c5", "g1f3"])).toBe("e2e4>c7c5>g1f3");
  });

  it("restores expansion by line key after a rebuild", () => {
    const { sectionData } = buildScoutSectionReport(
      scoutModule,
      {
        games: GAMES,
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    const line = sectionData.prepTargets?.[0] || sectionData.gradedLines[0];
    const key = scoutLineKey(line.ucis);
    const lineEl = createStubElement("div");
    lineEl.classList.add("scout-line");
    lineEl.dataset.lineKey = key;
    lineEl.dataset.color = "white";
    lineEl.dataset.rowIdx = "0";
    lineEl.dataset.rowKind = "prep";
    const results = createStubElement("div");
    results._line = lineEl;
    results.querySelectorAll = (sel) =>
      sel === ".scout-line[data-line-key]" ? [lineEl] : [];
    results.scrollTop = 0;
    restoreScoutExpanded(
      results,
      { white: sectionData },
      { expandedKeys: new Set([key]), scrollTop: 88 },
      {
        scoutModule,
        escapeHtml,
        ecoCache: new Map(),
        createElement: createStubElement,
        callbacks: {
          scoutLineDetailHtml: () => '<div class="scout-miniboard"></div>',
          enrichEcoForLine: vi.fn(),
        },
      },
    );
    expect(lineEl.classList.contains("is-expanded")).toBe(true);
    expect(lineEl.getAttribute("aria-expanded")).toBe("true");
    expect(lineEl.nextElementSibling?.classList.contains("scout-line-detail")).toBe(true);
    expect(results.scrollTop).toBe(88);
  });

  it("preserves expansion across a simulated live re-render", () => {
    const { sectionData } = buildScoutSectionReport(
      scoutModule,
      {
        games: GAMES,
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    const line = sectionData.prepTargets?.[0] || sectionData.gradedLines[0];
    const key = scoutLineKey(line.ucis);

    const lineElBefore = createStubElement("div");
    lineElBefore.classList.add("scout-line", "is-expanded");
    lineElBefore.dataset.lineKey = key;
    lineElBefore.dataset.color = "white";
    const resultsBefore = createStubElement("div");
    resultsBefore._lines = [lineElBefore];
    resultsBefore.querySelectorAll = (sel) =>
      sel === ".scout-line.is-expanded[data-line-key]" ? resultsBefore._lines : [];
    resultsBefore.scrollTop = 64;
    const captured = captureScoutExpanded(resultsBefore);

    const { sectionData: sectionData2 } = buildScoutSectionReport(
      scoutModule,
      {
        games: [...GAMES, { ...GAMES[0], datestamp: 4000 }],
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    const lineElAfter = createStubElement("div");
    lineElAfter.classList.add("scout-line");
    lineElAfter.dataset.lineKey = key;
    lineElAfter.dataset.color = "white";
    lineElAfter.dataset.rowIdx = "0";
    lineElAfter.dataset.rowKind = "prep";
    const resultsAfter = createStubElement("div");
    resultsAfter._lines = [lineElAfter];
    resultsAfter.querySelectorAll = (sel) =>
      sel === ".scout-line[data-line-key]" ? resultsAfter._lines : [];
    restoreScoutExpanded(
      resultsAfter,
      { white: sectionData2 },
      captured,
      {
        scoutModule,
        escapeHtml,
        ecoCache: new Map(),
        createElement: createStubElement,
        callbacks: {
          scoutLineDetailHtml: () => '<div class="scout-miniboard"></div>',
          enrichEcoForLine: vi.fn(),
        },
      },
    );

    expect(lineElAfter.classList.contains("is-expanded")).toBe(true);
    expect(lineElAfter.nextElementSibling?.classList.contains("scout-line-detail")).toBe(true);
    expect(resultsAfter.scrollTop).toBe(64);
  });
});

describe("scout-report rendering", () => {
  it("renders speed chips with the active filter highlighted", () => {
    const html = renderScoutProfile(
      { total: 40, ratingMin: 1700, ratingMax: 1900, speedCounts: { blitz: 30 } },
      "rival",
      "blitz",
      escapeHtml,
    );
    expect(html).toContain('data-speed="blitz"');
    expect(html).toContain('scout-speed-chip is-on" data-speed="blitz"');
    expect(html).not.toContain('data-speed="all" class="scout-speed-chip is-on"');
  });

  it("shows integer game counts in section HTML while weighting internally", () => {
    const { html } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        profile: {
          recentlyChanged: { white: false, black: false },
        },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    expect(html).toContain('<span class="scout-games-count">15 games</span>');
    expect(html).not.toContain("scout-lr-rank");
    expect(html).toContain("scout-n");
    expect(html).not.toMatch(/games-count">\d+\.\d/);
  });

  it("builds Analyze PGN with the scouted player on the correct side", () => {
    const line = { sans: ["e4", "c5", "Nf3"] };
    const pgn = buildScoutAnalyzePgn(line, "white", "rival");
    expect(pgn).toContain('[White "rival"]');
    expect(pgn).toContain('[Black "?"]');
    expect(pgn).toContain("1. e4 c5 2. Nf3");
  });

  it("rebuilds Analyze PGN SAN from UCI so stale scout SAN cannot create illegal lines", () => {
    const ucis = [
      "d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "b7b6", "g1f3", "c8b7",
      "c1g5", "h7h6", "g5h4", "g7g5", "h4g3", "f8g7", "e2e3", "d7d6",
      "f1e2", "e8g8", "e1g1", "b8d7", "d4d5", "e6e5", "e3e4", "d7c5",
      "e2d3", "a7a5", "a2a3", "a5a4", "h2h4", "f6h5", "h4g5", "h6g5",
      "f3e1", "h5f4", "g3f4", "e5f4", "d1g4", "b7c8", "g4f3", "d8f6",
      "e1c2", "g5g4", "f3d1", "f6h4", "c3e2", "g4g3", "f2g3", "f4g3",
      "e2g3",
    ];
    const staleSans = [
      "d4", "Nf6", "c4", "e6", "Nc3", "b6", "Nf3", "Bb7", "Bg5", "h6",
      "Bh4", "g5", "Bg3", "Bg7", "e3", "d6", "Be2", "O-O", "O-O", "Nbd7",
      "d5", "e5", "e4", "Nc5", "Bd3", "a5", "a3", "a4", "h4", "Nh5",
      "hxg5", "hxg5", "Ne1", "Nf4", "Bxf4", "exf4", "Qg4", "Bc8", "Qf3",
      "Qf6", "Qd1", "Qh4", "Ne2", "g3", "fxg3", "fxg3", "Nxg3",
    ];
    const rebuilt = legalScoutLineSans({ ucis, sans: staleSans });
    expect(rebuilt.slice(40, 45)).toEqual(["Nc2", "g4", "Qd1", "Qh4", "Ne2"]);

    const chess = new Chess();
    for (const san of rebuilt) expect(chess.move(san)).toBeTruthy();
    const pgn = buildScoutAnalyzePgn({ ucis, sans: staleSans }, "white", "unbrainless87");
    expect(pgn).toContain("21. Nc2 g4 22. Qd1 Qh4");
  });

  it("renders a miniboard and always shows Add to prep", () => {
    const line = {
      sans: ["e4"],
      ucis: ["e2e4"],
      prepared: true,
      repId: "rep-black",
      deepestNodeId: "n1",
    };
    const html = scoutLineDetailHtml(line, 0, "white", "line", {
      fenAfterLine: scoutModule.fenAfterLine,
      renderBoard: (fen, orientation) =>
        `<board fen="${fen}" orient="${orientation}"></board>`,
      escapeHtml,
    });
    expect(html).toContain("scout-miniboard-wrap");
    expect(html).toContain("scout-action-add-prep");
    expect(html).toContain('data-row-idx="0"');
  });

  it("uses the speed-filtered colour baseline, not all-speed profile stats", () => {
    const mixed = [
      scoutGameRecord({
        color: "white",
        score: 1,
        sans: ["e4", "c5"],
        ucis: ["e2e4", "c7c5"],
        speed: "blitz",
        datestamp: 1_700_000_000_000,
        gameId: "blitz-win",
      }),
      scoutGameRecord({
        color: "white",
        score: 1,
        sans: ["e4", "c5"],
        ucis: ["e2e4", "c7c5"],
        speed: "blitz",
        datestamp: 1_700_000_000_000,
        gameId: "blitz-win-2",
      }),
      scoutGameRecord({
        color: "white",
        score: 0,
        sans: ["d4", "d5"],
        ucis: ["d2d4", "d7d5"],
        speed: "rapid",
        datestamp: 1_700_000_000_000,
        gameId: "rapid-loss",
      }),
      scoutGameRecord({
        color: "white",
        score: 0,
        sans: ["d4", "d5"],
        ucis: ["d2d4", "d7d5"],
        speed: "rapid",
        datestamp: 1_700_000_000_000,
        gameId: "rapid-loss-2",
      }),
    ];
    const { sectionData } = buildScoutSectionReport(
      scoutModule,
      {
        games: mixed,
        profile: {
          recentlyChanged: { white: false, black: false },
          colorStats: {
            white: { games: 4, w: 2, d: 0, l: 2, scorePct: 50 },
            black: { games: 0, w: 0, d: 0, l: 0, scorePct: 0 },
          },
        },
      },
      "white",
      [],
      { speedFilter: "blitz", escapeHtml },
    );
    expect(sectionData.baselineScorePct).toBe(100);
    expect(sectionData.prepTargets.length).toBeGreaterThan(0);
  });

  it("explains why a game-plan row was recommended from existing selector fields", () => {
    const reason = scoutRouteReasonText(
      {
        maiaScorePct: 38,
        games: 4,
        belowBaseline: 12,
        lastSeen: { lastDatestamp: Date.now(), daysAgo: 0 },
      },
      50,
    );
    expect(reason).toContain("Maia estimates they score 38%");
    expect(reason).toContain("seen in 4 games");
    expect(reason).toContain("last played today");

    const html = scoutLineDetailHtml(
      {
        sans: ["e4"],
        ucis: ["e2e4"],
        maiaScorePct: 38,
        games: 4,
        belowBaseline: 12,
      },
      0,
      "white",
      "prep",
      {
        fenAfterLine: scoutModule.fenAfterLine,
        renderBoard: () => "<board></board>",
        escapeHtml,
        baseline: 50,
      },
    );
    expect(html).toContain("scout-line-reason");
    expect(html).toContain("Maia estimates they score 38%");
  });

  it("uses profile colour baseline instead of weighted trie score", () => {
    const { sectionData } = buildScoutSectionReport(
      scoutModule,
      {
        games: GAMES,
        profile: {
          recentlyChanged: { white: false, black: false },
          colorStats: {
            white: { games: 3, w: 1, d: 0, l: 2, scorePct: 55 },
            black: { games: 0, w: 0, d: 0, l: 0, scorePct: 0 },
          },
        },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    expect(sectionData.baselineScorePct).toBe(55);
  });

  it("renders coverage bar in v3/v6 mode (engine-free self-review)", () => {
    const { html } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        profile: {
          recentlyChanged: { white: false, black: false },
          colorStats: {
            white: { games: 15, w: 7, d: 0, l: 8, scorePct: 47 },
            black: { games: 0, w: 0, d: 0, l: 0, scorePct: 0 },
          },
        },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml, v3Mode: true },
    );
    expect(html).toContain("scout-coverage-bar-row");
    expect(html).toContain("lines covered");
    expect(html).toContain("scout-prepare-all");
    expect(html).not.toContain("scout-ranked-list");
  });

  it("renders ranked game plan with sample sizes", () => {
    const { html } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        profile: {
          recentlyChanged: { white: false, black: false },
          colorStats: {
            white: { games: 15, w: 7, d: 0, l: 8, scorePct: 47 },
            black: { games: 0, w: 0, d: 0, l: 0, scorePct: 0 },
          },
        },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    expect(html).toContain("Your game plan");
    expect(html).toContain("When they play");
    expect(html).toContain("scout-ranked-list");
    expect(html).not.toContain("scout-lr-rank");
    expect(html).toContain("scout-n");
  });

  it("ranked prep rows expose four grid cells (no count/share) for desktop layout", () => {
    const { html } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        profile: {
          recentlyChanged: { white: false, black: false },
          colorStats: {
            white: { games: 15, w: 7, d: 0, l: 8, scorePct: 47 },
            black: { games: 0, w: 0, d: 0, l: 0, scorePct: 0 },
          },
        },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    const rowStart = html.indexOf("scout-ranked-row");
    expect(rowStart).toBeGreaterThan(-1);
    const rowSlice = html.slice(rowStart, rowStart + 2500);
    // Game-plan rows drop ×N count and share% — both are always trivially 1 / <1% on
    // deep lines. Four cells remain: moves, score, wdl, action.
    expect(rowSlice).not.toContain("scout-lr-rank");
    expect(rowSlice).not.toContain("scout-lr-share");
    for (const cell of ["scout-lr-main", "scout-lr-score", "scout-lr-wdl", "scout-lr-action"]) {
      expect(rowSlice).toContain(cell);
    }
  });
});

describe("scout-report interactions", () => {
  it("speed chip click updates state and rerenders without refetching games", () => {
    const state = {
      username: "rival",
      games: GAMES,
      profile: { total: 3, speedCounts: {}, recentlyChanged: { white: false, black: false } },
      lookups: LOOKUPS,
      activeSpeed: "all",
      sections: {},
    };
    const fetchGames = vi.fn();
    const onSpeedChange = vi.fn(() => {
      buildScoutSectionReport(scoutModule, state, "white", LOOKUPS.black, {
        speedFilter: state.activeSpeed,
        escapeHtml,
      });
    });

    const chip = createStubElement("button");
    chip.classList.add("scout-speed-chip");
    chip.dataset.speed = "blitz";

    const changed = handleScoutProfileClick(
      {
        target: {
          closest: (sel) => (sel === ".scout-speed-chip" ? chip : null),
        },
      },
      { getState: () => state, onSpeedChange },
    );
    expect(changed).toBe(true);
    expect(state.activeSpeed).toBe("blitz");
    expect(onSpeedChange).toHaveBeenCalledTimes(1);
    expect(fetchGames).not.toHaveBeenCalled();
  });

  it("expands a line row and inserts a detail panel with a miniboard", async () => {
    const { sectionData } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    const state = {
      username: "rival",
      sections: { white: sectionData },
    };
    const lineEl = createStubElement("div");
    lineEl.classList.add("scout-line");
    lineEl.dataset.rowIdx = "0";
    lineEl.dataset.rowKind = "prep";
    lineEl.dataset.color = "white";

    await handleScoutResultsClick(
      {
        target: {
          closest: (sel) => {
            if (sel === ".scout-line") return lineEl;
            if (sel.includes("scout-badge")) return null;
            return null;
          },
        },
      },
      {
        getState: () => state,
        scoutModule,
        escapeHtml,
        createElement: createStubElement,
        callbacks: {
          scoutLineDetailHtml: () => '<div class="scout-miniboard"></div>',
          enrichEcoForLine: vi.fn(),
          restoreDistRoot: vi.fn(),
          renderDistDrilldown: vi.fn(),
          scoutPrepareAll: vi.fn(),
          scoutAnalyzeLine: vi.fn(),
          editRepertoire: vi.fn(),
          selectBuildNode: vi.fn(),
        },
      },
    );

    expect(lineEl.classList.contains("is-expanded")).toBe(true);
    const detail = lineEl.nextElementSibling;
    expect(detail?.classList.contains("scout-line-detail")).toBe(true);
    expect(detail?.innerHTML).toContain("scout-miniboard");
  });

  it("routes Analyze, Add to prep, and Prepare all actions to callbacks", async () => {
    const { sectionData } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    const state = {
      username: "rival",
      sections: { white: sectionData },
    };
    const callbacks = {
      scoutLineDetailHtml: () =>
        '<button class="scout-action-analyze" data-row-kind="prep" data-row-idx="0"></button><button class="scout-action-add-prep" data-row-kind="prep" data-row-idx="0" data-color="white"></button>',
      enrichEcoForLine: vi.fn(),
      restoreDistRoot: vi.fn(),
      renderDistDrilldown: vi.fn(),
      scoutPrepareAll: vi.fn(),
      scoutAddToPrep: vi.fn(async () => {}),
      scoutAnalyzeLine: vi.fn(),
      editRepertoire: vi.fn(async () => {}),
      selectBuildNode: vi.fn(async () => {}),
    };
    const ctx = {
      getState: () => state,
      scoutModule,
      escapeHtml,
      createElement: createStubElement,
      callbacks,
    };

    const lineEl = createStubElement("div");
    lineEl.classList.add("scout-line");
    lineEl.dataset.rowIdx = "0";
    lineEl.dataset.rowKind = "prep";
    lineEl.dataset.color = "white";
    await handleScoutResultsClick(
      {
        target: {
          closest: (sel) => (sel === ".scout-line" ? lineEl : null),
        },
      },
      ctx,
    );

    const detail = lineEl.nextElementSibling;
    detail.previousElementSibling = lineEl;
    const analyzeBtn = createStubElement("button");
    analyzeBtn.classList.add("scout-action-analyze");
    analyzeBtn.dataset.rowIdx = "0";
    analyzeBtn.dataset.rowKind = "prep";
    analyzeBtn.closest = (sel) => {
      if (sel === ".scout-action-analyze") return analyzeBtn;
      if (sel === ".scout-line-detail") return detail;
      return null;
    };
    await handleScoutResultsClick({ target: analyzeBtn }, ctx);
    const prepLine = sectionData.prepTargets?.[0] || sectionData.gradedLines[0];
    expect(callbacks.scoutAnalyzeLine).toHaveBeenCalledWith(prepLine, "white", "rival");

    const addBtn = createStubElement("button");
    addBtn.classList.add("scout-action-add-prep");
    addBtn.dataset.rowKind = "prep";
    addBtn.dataset.rowIdx = "0";
    addBtn.dataset.color = "white";
    addBtn.closest = (sel) => (sel === ".scout-action-add-prep" ? addBtn : null);
    await handleScoutResultsClick({ target: addBtn }, ctx);
    expect(callbacks.scoutAddToPrep).toHaveBeenCalledWith(prepLine, "white");

    const prepAllBtn = createStubElement("button");
    prepAllBtn.classList.add("scout-prepare-all");
    prepAllBtn.dataset.color = "white";
    prepAllBtn.closest = (sel) => (sel === ".scout-prepare-all" ? prepAllBtn : null);
    await handleScoutResultsClick({ target: prepAllBtn }, ctx);
    expect(callbacks.scoutPrepareAll).toHaveBeenCalled();
  });
});

describe("Maia estimate rendering", () => {
  it("scoutLineWdlCounts maps Maia win/draw/loss for full renderer path", () => {
    const counts = scoutLineWdlCounts({
      maiaWdl: { win: 150, draw: 250, loss: 600 },
      w: 9,
      d: 0,
      l: 1,
    });
    expect(counts).toEqual({ w: 150, d: 250, l: 600 });
    const bar = scoutWdlBar(counts.w, counts.d, counts.l, { maiaEstimate: true });
    expect(bar).toContain('style="width:15%"');
    expect(bar).toContain('style="width:60%"');
  });

  it("re-render keeps Maia WDL after section rebuild with maiaResults cache", () => {
    const maiaResults = new Map();
    const lineUcis = ["e2e4", "c7c5", "g1f3"];
    const fen = scoutModule.fenAfterLine(lineUcis);
    rememberMaiaResult(maiaResults, fen, 1800, {
      maiaWdl: { win: 120, draw: 180, loss: 700 },
      maiaScorePct: 27,
    });
    const londonUcis = ["d2d4", "d7d5", "c2c4"];
    rememberMaiaResult(maiaResults, scoutModule.fenAfterLine(londonUcis), 1800, {
      maiaWdl: { win: 200, draw: 200, loss: 600 },
      maiaScorePct: 40,
    });
    const base = {
      games: PLAN_GAMES,
      username: "rival",
      profile: { recentlyChanged: { white: false, black: false } },
    };
    const opts = {
      speedFilter: "all",
      escapeHtml,
      maiaResults,
      maiaRatings: { white: 1800, black: 1800 },
      maiaEnrichState: MAIA_ENRICH_READY,
    };
    const first = buildScoutSectionReport(scoutModule, base, "white", LOOKUPS.black, opts);
    const second = buildScoutSectionReport(scoutModule, base, "white", LOOKUPS.black, opts);
    const sicilianKey = scoutLineKey(lineUcis);
    const firstRow = first.sectionData.prepTargets.find((t) => scoutLineKey(t.ucis) === sicilianKey);
    const secondRow = second.sectionData.prepTargets.find(
      (t) => scoutLineKey(t.ucis) === sicilianKey,
    );
    expect(firstRow?.maiaScorePct).toBe(27);
    expect(secondRow?.maiaScorePct).toBe(27);
    expect(first.html).toContain("scout-maia-estimate");
    expect(second.html).toContain('style="width:70%"');
    expect(second.html).toContain("score/WDL are Maia estimates");
  });

  it("re-ranks prep rows when Maia scores change exploitability", () => {
    const maiaResults = new Map();
    const d4Fen = scoutModule.fenAfterLine(["d2d4", "d7d5"]);
    const sicilianFen = scoutModule.fenAfterLine(["e2e4", "c7c5", "g1f3"]);
    rememberMaiaResult(maiaResults, d4Fen, 1800, {
      maiaWdl: { win: 800, draw: 100, loss: 100 },
      maiaScorePct: 82,
    });
    rememberMaiaResult(maiaResults, sicilianFen, 1800, {
      maiaWdl: { win: 100, draw: 100, loss: 800 },
      maiaScorePct: 15,
    });
    const { sectionData } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        username: "rival",
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      LOOKUPS.black,
      {
        speedFilter: "all",
        escapeHtml,
        maiaResults,
        maiaRatings: { white: 1800, black: 1800 },
        maiaEnrichState: MAIA_ENRICH_READY,
      },
    );
    expect(sectionData.prepTargets[0].ucis).toEqual(["e2e4", "c7c5", "g1f3"]);
    expect(sectionData.prepTargets[0].maiaScorePct).toBe(15);
  });

  it("shows loading note while Maia enrichment is in flight", () => {
    const { html } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        username: "rival",
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml, maiaEnrichState: MAIA_ENRICH_LOADING },
    );
    expect(html).toContain("Evaluating");
    expect(html).not.toContain("score/WDL are Maia estimates");
  });

  it("scoutScoreCell and scoutWdlBar tag Maia estimates", () => {
    expect(scoutScoreCell(42, 5, { maiaEstimate: true })).toContain("scout-maia-estimate");
    expect(scoutScoreCell(42, 5, { maiaEstimate: true })).toContain("Maia strength estimate");
    expect(scoutWdlBar(300, 200, 500, { maiaEstimate: true })).toContain("scout-maia-estimate");
    expect(scoutWdlBar(300, 200, 500, { maiaEstimate: true })).toContain("Maia W/D/L estimate");
  });

  it("patchScoutLineMaiaCells updates score and WDL cells in place", () => {
    const scoreEl = createStubElement("span");
    scoreEl.classList.add("scout-lr-score");
    scoreEl.innerHTML = '<span class="scout-score-pct">70%</span>';
    const wdlEl = createStubElement("span");
    wdlEl.classList.add("scout-lr-wdl");
    wdlEl.innerHTML = '<span class="scout-wdlbar"></span>';
    const movesEl = createStubElement("span");
    movesEl.classList.add("scout-line-moves");
    movesEl.innerHTML =
      '<span class="scout-prep-chip scout-prep-chip-attack">attack</span>';
    const row = createStubElement("div");
    row.querySelector = (sel) => {
      if (sel === ".scout-lr-score") return scoreEl;
      if (sel === ".scout-lr-wdl") return wdlEl;
      if (sel === ".scout-line-moves") return movesEl;
      return null;
    };
    const chipStub = createStubElement("span");
    chipStub.remove = () => {
      movesEl.innerHTML = "";
    };
    movesEl.querySelectorAll = (sel) => {
      if (sel === ".scout-prep-chip" && movesEl.innerHTML.includes("scout-prep-chip")) {
        return [chipStub];
      }
      return [];
    };
    movesEl.insertAdjacentHTML = (_pos, html) => {
      movesEl.innerHTML += html;
    };
    patchScoutLineMaiaCells(row, {
      maiaScorePct: 38,
      maiaWdl: { win: 200, draw: 300, loss: 500 },
      games: 4,
      belowBaseline: 12,
      prepCategory: "attack",
    }, 50);
    expect(scoreEl.innerHTML).toContain("38%");
    expect(scoreEl.innerHTML).toContain("scout-maia-estimate");
    expect(wdlEl.innerHTML).toContain("scout-maia-estimate");
    expect(movesEl.innerHTML).toContain("scout-prep-chip-attack");
  });
});

describe("scout intelligence panel", () => {
  it("renders worst-performance panel and NL summary in section HTML", () => {
    const { html, sectionData } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        username: "rival",
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    expect(html).toContain("scout-intel-summary-only");
    expect(html).toContain("scout-intel-charts-strip");
    expect(html).toContain("scout-ranked-list");
    expect(html).toContain("scout-ranked-note");
    expect(html).not.toContain("scout-lr-rank");
    expect(html).toContain("Worst performance");
    expect(html).toContain("Activity");
    expect(html).toContain("Repertoire focus");
    expect(html).toContain("scout-sparkline");
    expect(html).toContain("scout-bar-chart");
    expect(html).toContain("visually-hidden");
    expect(html).toContain("scout-repertoire-reads");
    expect(html).toContain("scout-read-chip");
    expect(html).toContain("Engine ACPL");
    expect(html).toContain("Engine scan: run Deep scan");
    expect(sectionData.stats).toBeDefined();
    expect(sectionData.summary?.headline).toBeTruthy();
  });

  it("does not repeat the headline as the first bullet", () => {
    const { html, sectionData } = buildScoutSectionReport(
      scoutModule,
      {
        games: PLAN_GAMES,
        username: "rival",
        profile: { recentlyChanged: { white: false, black: false } },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    const headline = sectionData.summary.headline;
    const bulletItems = html.match(/<li>[\s\S]*?<\/li>/g) || [];
    // The headline shows once in .scout-intel-headline; it must not also appear as a <li>.
    expect(bulletItems.some((li) => li.includes(escapeHtml(headline)))).toBe(false);
  });

  it("renderScoutEnginePanel shows insufficient coverage or ACPL bars", () => {
    expect(renderScoutEnginePanel(null, escapeHtml)).toContain("run Deep scan");
    expect(
      renderScoutEnginePanel(
        {
          sufficient: false,
          analyzedGames: 1,
          eligibleGames: 4,
          coveragePct: 25,
          minAnalyzedGames: 3,
          minCoveragePct: 60,
        },
        escapeHtml,
      ),
    ).toContain("coverage insufficient");
    expect(
      renderScoutEnginePanel(
        {
          sufficient: true,
          families: [{ san: "e4", acpl: 42, firstInaccuracyPly: 3, analyzedGames: 5 }],
        },
        escapeHtml,
      ),
    ).toContain("42 cp");
    expect(
      renderScoutEnginePanel(
        {
          sufficient: true,
          scopeLimited: true,
          maxGames: 60,
          families: [{ san: "e4", acpl: 42, firstInaccuracyPly: 3, analyzedGames: 5 }],
        },
        escapeHtml,
      ),
    ).toContain("based on latest 60 games");
  });

  it("renderScoutRefutationPanel shows only confirmed refutations", () => {
    const html = renderScoutRefutationPanel(
      [
        {
          refutation: { suggestedUci: "b1c3" },
          candidate: { pathSans: ["e4", "c5"] },
          evidence: [
            { layer: "engine", acpl: 42, analyzedGames: 5, scopeLimited: true, maxGames: 60 },
            { layer: "explorer", mastersSharePct: 12 },
          ],
        },
        {
          refutation: null,
          blockedBy: [{ layer: "engine", code: "no-scan" }],
        },
      ],
      escapeHtml,
    );
    expect(html).toContain("scout-refutation-hit");
    expect(html).toContain("1.e4 c5");
    expect(html).toContain("b1c3");
    expect(html).toContain("42 cp ACPL");
    expect(html).toContain("12% masters");
    expect(html).toContain("latest 60 games");
    expect(html).not.toContain("no-scan");
  });

  it("renderScoutRefutationPanel shows actionable gaps instead of blocked refutations", () => {
    const html = renderScoutRefutationPanel(
      [
        {
          refutation: null,
          blockedBy: [{ layer: "engine", code: "no-scan" }],
        },
      ],
      escapeHtml,
    );
    expect(html).toContain("Run Deep scan");
    expect(html).toContain('data-testid="scout-refutation-gap-deep-scan"');
    expect(html).toContain('data-refutation-gap="deep-scan"');
    expect(html).toContain('aria-label="Run deep engine scan to generate refutations"');
    expect(html).not.toContain("scout-refutation-hit");
  });

  it("renderScoutRefutationPanel renders connect-lichess gap CTA", () => {
    const html = renderScoutRefutationPanel(
      [
        {
          refutation: null,
          blockedBy: [{ layer: "explorer", code: "auth" }],
        },
      ],
      escapeHtml,
    );
    expect(html).toContain('data-testid="scout-refutation-gap-connect-lichess"');
    expect(html).toContain('data-refutation-gap="connect-lichess"');
    expect(html).toContain("Connect Lichess account");
  });

  it("handleScoutRefutationGapClick delegates deep scan and lichess connect", () => {
    const runDeepScan = vi.fn();
    const connectLichess = vi.fn();
    const deepHandled = handleScoutRefutationGapClick(
      {
        target: {
          closest(sel) {
            return sel === "[data-refutation-gap]"
              ? { dataset: { refutationGap: "deep-scan" } }
              : null;
          },
        },
      },
      { callbacks: { runDeepScan, connectLichess } },
    );
    expect(deepHandled).toBe(true);
    expect(runDeepScan).toHaveBeenCalledTimes(1);
    expect(connectLichess).not.toHaveBeenCalled();

    const lichessHandled = handleScoutRefutationGapClick(
      {
        target: {
          closest(sel) {
            return sel === "[data-refutation-gap]"
              ? { dataset: { refutationGap: "connect-lichess" } }
              : null;
          },
        },
      },
      { callbacks: { runDeepScan, connectLichess } },
    );
    expect(lichessHandled).toBe(true);
    expect(connectLichess).toHaveBeenCalledTimes(1);
  });

  it("refutationA11ySummary describes hits and actionable gaps", () => {
    expect(
      refutationA11ySummary([
        {
          refutation: { suggestedUci: "g1f3" },
          candidate: { pathSans: ["e4", "c5"] },
          evidence: [
            { layer: "engine", acpl: 30, analyzedGames: 4 },
            { layer: "explorer", mastersSharePct: 18 },
          ],
        },
      ]),
    ).toContain("After 1.e4 c5, play g1f3");
    expect(
      refutationA11ySummary([
        {
          refutation: null,
          blockedBy: [{ layer: "explorer", code: "auth" }],
        },
      ]),
    ).toContain("Connect Lichess account");
  });

  it("buildScoutIntelligenceA11ySummary describes families and trends", () => {
    const stats = buildScoutIntelligenceA11ySummary({
      scoreByFamily: {
        families: [{ san: "e4", scorePct: 40, games: 5 }],
      },
      repertoireChangeTrend: { points: [40, 55, 70], trend: "up" },
      activitySeries: { recentWindow: [{ count: 2 }, { count: 0 }, { count: 1 }], recentGames: 3, recentBuckets: 3 },
    });
    expect(stats).toContain("1.e4 40%");
    expect(stats).toContain("Repertoire concentration trend improving");
    expect(stats).toContain("last 3 weeks: 3 games");
  });

  it("scoutSparkline emits inline SVG and scoutSvgBar emits HTML bars", () => {
    expect(scoutSparkline([40, 55, 30])).toContain("<polyline");
    const bars = scoutSvgBar([{ san: "e4", scorePct: 42 }], { escapeHtml });
    expect(bars).toContain("scout-bar-fill");
    expect(bars).toContain("scout-bar-row");
    expect(bars).not.toContain("<svg");
  });

  it("renderInlineRefutationCard shows positive swing for a black opponent blunder", () => {
    const html = renderInlineRefutationCard(
      {
        ucis: ["e2e4", "c7c5"],
        refutation: {
          playedSan: "c5",
          cpLoss: 40,
          suggestedUci: "b1c3",
          suggestedSan: "Nc3",
        },
      },
      "black",
      escapeHtml,
    );
    expect(html).toContain("scout-refutation-card");
    expect(html).toContain("+0.4");
    expect(html).not.toContain("-0.4");
    expect(html).toContain("Nc3");
  });
});
