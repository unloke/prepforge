import { describe, expect, it, vi } from "vitest";

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
  refutationA11ySummary,
  renderScoutProfile,
  restoreScoutExpanded,
  scoutLineDetailHtml,
  scoutLineKey,
  scoutSparkline,
  scoutSvgBar,
  scoutScoreCell,
  scoutMaiaJudgmentCell,
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

const GAMES = [
  {
    color: "white",
    score: 1,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    rating: 1800,
    datestamp: 3000,
    speed: "blitz",
  },
  {
    color: "white",
    score: 0,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    rating: 1800,
    datestamp: 2000,
    speed: "blitz",
  },
  {
    color: "white",
    score: 1,
    sans: ["d4", "d5"],
    ucis: ["d2d4", "d7d5"],
    rating: 1800,
    datestamp: 1000,
    speed: "blitz",
  },
];

const PLAN_GAMES = [
  ...Array.from({ length: 8 }, (_, i) => ({
    color: "white",
    score: i % 3 === 0 ? 1 : 0,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    rating: 1800,
    datestamp: 4000 - i * 100,
    speed: "blitz",
    gameId: `sicilian-${i}`,
  })),
  ...Array.from({ length: 7 }, (_, i) => ({
    color: "white",
    score: i % 2 === 0 ? 1 : 0,
    sans: ["d4", "d5"],
    ucis: ["d2d4", "d7d5"],
    rating: 1800,
    datestamp: 3000 - i * 100,
    speed: "blitz",
    gameId: `london-${i}`,
  })),
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
    expect(html).toContain("scout-lr-maia");
    expect(html).not.toContain("scout-lr-rank");
    expect(html).not.toMatch(/games-count">\d+\.\d/);
  });

  it("builds Analyze PGN with the scouted player on the correct side", () => {
    const line = { sans: ["e4", "c5", "Nf3"] };
    const pgn = buildScoutAnalyzePgn(line, "white", "rival");
    expect(pgn).toContain('[White "rival"]');
    expect(pgn).toContain('[Black "?"]');
    expect(pgn).toContain("1. e4 c5 2. Nf3");
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

  it("renders Maia3-ranked game plan without empirical sample sizes", () => {
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
    expect(html).toContain("scout-lr-maia");
    expect(html).not.toContain("scout-lr-rank");
    expect(html).not.toContain("scout-lr-wdl");
  });

  it("ranked prep rows expose the simplified game-plan grid", () => {
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
    for (const cell of ["scout-lr-main", "scout-lr-maia", "scout-lr-action"]) {
      expect(rowSlice).toContain(cell);
    }
    expect(rowSlice).not.toContain("scout-lr-rank");
    expect(rowSlice).not.toContain("scout-lr-wdl");
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
    const rowKind = sectionData.prepTargets?.length ? "prep" : "unassessed";
    lineEl.dataset.rowKind = rowKind;
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
    const rowKind = sectionData.prepTargets?.length ? "prep" : "unassessed";
    lineEl.dataset.rowKind = rowKind;
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
    analyzeBtn.dataset.rowKind = rowKind;
    analyzeBtn.closest = (sel) => {
      if (sel === ".scout-action-analyze") return analyzeBtn;
      if (sel === ".scout-line-detail") return detail;
      return null;
    };
    await handleScoutResultsClick({ target: analyzeBtn }, ctx);
    const prepLine =
      sectionData.prepTargets?.[0] ||
      sectionData.unassessedTargets?.[0] ||
      sectionData.gradedLines[0];
    expect(callbacks.scoutAnalyzeLine).toHaveBeenCalledWith(prepLine, "white", "rival");

    const addBtn = createStubElement("button");
    addBtn.classList.add("scout-action-add-prep");
    addBtn.dataset.rowKind = rowKind;
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
    expect(first.html).toContain("scout-maia-judgment");
    expect(second.html).toContain("Your edge");
    expect(second.html).toContain("opp 27%");
    expect(second.html).toContain("Among assessed lines");
    expect(second.html).not.toContain("scout-lr-wdl");
    expect(second.html).not.toContain("<1%");
  });

  it("re-ranks prep rows when Maia scores change", () => {
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
    expect(html).toContain("re-rank as Maia3 completes");
    expect(html).not.toContain("scout-lr-wdl");
  });

  it("scoutScoreCell and scoutWdlBar tag Maia estimates", () => {
    expect(scoutScoreCell(42, 5, { maiaEstimate: true })).toContain("scout-maia-estimate");
    expect(scoutScoreCell(42, 5, { maiaEstimate: true })).toContain("Maia strength estimate");
    expect(scoutWdlBar(300, 200, 500, { maiaEstimate: true })).toContain("scout-maia-estimate");
    expect(scoutWdlBar(300, 200, 500, { maiaEstimate: true })).toContain("Maia W/D/L estimate");
  });

  it("scoutMaiaJudgmentCell labels player perspective at leaf before your reply", () => {
    const leaf = scoutMaiaJudgmentCell({ maiaScorePct: 32 });
    expect(leaf).toContain("Your edge");
    expect(leaf).toContain("opp 32%");
    expect(leaf).toContain("before your reply");
    expect(scoutMaiaJudgmentCell({ maiaScorePct: 44 })).toContain("Your edge");
    expect(scoutMaiaJudgmentCell({ maiaScorePct: 48 })).toContain("Balanced");
    expect(scoutMaiaJudgmentCell({ maiaScorePct: 56 })).toContain("Their edge");
    expect(scoutMaiaJudgmentCell({ maiaScorePct: 62 })).toContain("Their edge");
    expect(scoutMaiaJudgmentCell({}, { maiaEnrichState: "loading" })).toContain("Evaluating");
    expect(scoutMaiaJudgmentCell({})).toContain("Unavailable");
  });

  it("patchScoutLineMaiaCells updates Maia judgment cell in place", () => {
    const maiaEl = createStubElement("span");
    maiaEl.classList.add("scout-lr-maia");
    maiaEl.innerHTML = '<span class="scout-maia-judgment-pending">Evaluating…</span>';
    const row = createStubElement("div");
    row.querySelector = (sel) => (sel === ".scout-lr-maia" ? maiaEl : null);
    patchScoutLineMaiaCells(row, { maiaScorePct: 38 }, 50);
    expect(maiaEl.innerHTML).toContain("Your edge");
    expect(maiaEl.innerHTML).toContain("opp 38%");
    expect(maiaEl.innerHTML).toContain("scout-maia-judgment-good");
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
    expect(html).toContain("scout-lr-maia");
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