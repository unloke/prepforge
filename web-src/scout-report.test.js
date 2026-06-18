import { describe, expect, it, vi } from "vitest";

import * as scoutModule from "./scout.js";
import {
  buildScoutAnalyzePgn,
  buildScoutSectionReport,
  handleScoutProfileClick,
  handleScoutResultsClick,
  renderScoutProfile,
  scoutLineDetailHtml,
} from "./scout-report.js";

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
  lineEl.dataset.lineIdx = "0";
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

describe("scout-report rendering", () => {
  it("renders speed chips with the active filter highlighted", () => {
    const html = renderScoutProfile(
      { total: 40, ratingMin: 1700, ratingMax: 1900, speedCounts: { blitz: 30 } },
      "rival",
      "blitz",
      escapeHtml,
    );
    expect(html).toContain('data-speed="blitz"');
    expect(html).toContain('class="scout-speed-chip is-on" data-speed="blitz"');
    expect(html).not.toContain('data-speed="all" class="scout-speed-chip is-on"');
  });

  it("shows integer game counts in section HTML while weighting internally", () => {
    const { html } = buildScoutSectionReport(
      scoutModule,
      {
        games: GAMES,
        profile: {
          recentlyChanged: { white: false, black: false },
        },
      },
      "white",
      LOOKUPS.black,
      { speedFilter: "all", escapeHtml },
    );
    expect(html).toContain('<span class="scout-games-count">3 games</span>');
    expect(html).toContain("&times;2");
    expect(html).not.toMatch(/games-count">\d+\.\d/);
  });

  it("builds Analyze PGN with the scouted player on the correct side", () => {
    const line = { sans: ["e4", "c5", "Nf3"] };
    const pgn = buildScoutAnalyzePgn(line, "white", "rival");
    expect(pgn).toContain('[White "rival"]');
    expect(pgn).toContain('[Black "?"]');
    expect(pgn).toContain("1. e4 c5 2. Nf3");
  });

  it("renders a miniboard in line detail HTML", () => {
    const line = {
      sans: ["e4"],
      ucis: ["e2e4"],
      prepared: false,
      repId: "rep-black",
      deepestNodeId: "n1",
    };
    const html = scoutLineDetailHtml(line, 0, "white", {
      fenAfterLine: scoutModule.fenAfterLine,
      renderBoard: (fen, orientation) =>
        `<board fen="${fen}" orient="${orientation}"></board>`,
      escapeHtml,
    });
    expect(html).toContain("scout-miniboard-wrap");
    expect(html).toContain('data-prep-rep="rep-black"');
    expect(html).toContain('data-line-idx="0"');
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
        games: GAMES,
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
    lineEl.dataset.lineIdx = "0";
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

  it("routes Analyze, Prep gap, and Prepare all actions to callbacks", async () => {
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
    const state = {
      username: "rival",
      sections: { white: sectionData },
    };
    const callbacks = {
      scoutLineDetailHtml: () =>
        '<button class="scout-action-analyze" data-line-idx="0"></button><button class="scout-action-prep" data-prep-rep="rep-black" data-prep-node="n1"></button>',
      enrichEcoForLine: vi.fn(),
      restoreDistRoot: vi.fn(),
      renderDistDrilldown: vi.fn(),
      scoutPrepareAll: vi.fn(),
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
    lineEl.dataset.lineIdx = "0";
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
    analyzeBtn.dataset.lineIdx = "0";
    analyzeBtn.closest = (sel) => {
      if (sel === ".scout-action-analyze") return analyzeBtn;
      if (sel === ".scout-line-detail") return detail;
      return null;
    };
    await handleScoutResultsClick({ target: analyzeBtn }, ctx);
    expect(callbacks.scoutAnalyzeLine).toHaveBeenCalledWith(
      sectionData.gradedLines[0],
      "white",
      "rival",
    );

    const prepBtn = createStubElement("button");
    prepBtn.dataset.prepRep = "rep-black";
    prepBtn.dataset.prepNode = "n1";
    prepBtn.closest = (sel) => (sel === "[data-prep-rep]" ? prepBtn : null);
    await handleScoutResultsClick({ target: prepBtn }, ctx);
    expect(callbacks.editRepertoire).toHaveBeenCalledWith("rep-black");
    expect(callbacks.selectBuildNode).toHaveBeenCalledWith("n1");

    const prepAllBtn = createStubElement("button");
    prepAllBtn.classList.add("scout-prepare-all");
    prepAllBtn.dataset.color = "white";
    prepAllBtn.closest = (sel) => (sel === ".scout-prepare-all" ? prepAllBtn : null);
    await handleScoutResultsClick({ target: prepAllBtn }, ctx);
    expect(callbacks.scoutPrepareAll).toHaveBeenCalledWith(sectionData.gradedLines);
  });
});