// Eval chart behaviour (web-src/views/analyze.js): mouse, keyboard, dark-theme
// token wiring, and the current-ply position state. DOM-free harness — a small
// fake tree keeps this a fast unit test (the real browser flow is covered by
// tests/e2e/eval_chart_smoke.mjs).
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAnalyzeView } from "./analyze.js";

const STYLES = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
// The chart rules ship in a lazy sheet (loaded with the Analyze view) so the
// eager styles.css stays under its deploy budget. The token contract spans both:
// theme variables live in styles.css, the chart selectors in analyze-chart.css.
const CHART_STYLES = readFileSync(
  new URL("./analyze-chart.css", import.meta.url),
  "utf8",
);
const ALL_STYLES = `${STYLES}\n${CHART_STYLES}`;

// ---- Minimal fake DOM -------------------------------------------------------

class FakeElement {
  constructor(doc, tag) {
    this.doc = doc;
    this.tag = tag;
    this.attrs = new Map();
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.textContent = "";
    this._innerHTML = "";
    this.rectWidth = 640;
    this.classList = {
      add: (...names) => {
        const set = new Set((this.attrs.get("class") || "").split(/\s+/).filter(Boolean));
        names.forEach((name) => set.add(name));
        this.attrs.set("class", [...set].join(" "));
      },
    };
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (value === "") {
      this.children.forEach((child) => this.doc._unregisterTree(child));
      this.children = [];
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === "id") this.doc.byId.set(String(value), this);
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  dispatch(type, event = {}) {
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn(), ...event };
    (this.listeners[type] || []).forEach((fn) => fn(e));
    return e;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.rectWidth, height: 96 };
  }

  querySelectorAll(selector) {
    const out = [];
    const wanted = selector.startsWith(".") ? selector.slice(1).split(".") : null;
    const match = (el) => {
      if (wanted) {
        const have = (el.attrs.get("class") || "").split(/\s+/);
        return wanted.every((cls) => have.includes(cls));
      }
      return el.attrs.get("id") === selector.slice(1);
    };
    const walk = (el) =>
      el.children.forEach((child) => {
        if (match(child)) out.push(child);
        walk(child);
      });
    walk(this);
    return out;
  }
}

function makeDoc() {
  const doc = {
    byId: new Map(),
    activeElement: null,
    querySelector: () => null,
    createElementNS: (_ns, tag) => new FakeElement(doc, tag),
    createElement: (tag) => new FakeElement(doc, tag),
    getElementById: (id) => doc.byId.get(id) || null,
    _unregisterTree(el) {
      if (el.attrs.get("id")) doc.byId.delete(el.attrs.get("id"));
      el.children.forEach((child) => doc._unregisterTree(child));
    },
  };
  return doc;
}

// ---- Harness ----------------------------------------------------------------

const POINTS = [
  { ply: 1, san: "e4", score_cp: 30, bounded_score_cp: 30, classification: "best" },
  { ply: 2, san: "e5", score_cp: 20, bounded_score_cp: 20, classification: "good" },
  { ply: 3, san: "Nf3", score_cp: -80, bounded_score_cp: -80, classification: "inaccuracy" },
  { ply: 4, san: "Nc6", score_cp: -120, bounded_score_cp: -120, classification: "mistake" },
  { ply: 5, san: "Bb5", score_cp: -400, bounded_score_cp: -400, classification: "blunder" },
];

function setup() {
  const doc = makeDoc();
  globalThis.document = doc;
  const chart = doc.createElement("svg");
  chart.setAttribute("id", "eval-chart");
  const tooltip = doc.createElement("div");
  tooltip.setAttribute("id", "eval-chart-tooltip");
  tooltip.hidden = true;
  const appState = {
    analysisPly: 0,
    evalChartPoints: [],
    analysisVarNodes: new Map(),
  };
  const showAnalysisPly = vi.fn(async () => {});
  const view = createAnalyzeView({
    appState,
    escapeHtml: (s) => String(s),
    START_FEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    showAnalysisPly,
    selectAnalysisNode: vi.fn(async () => {}),
    revealAnalysisResults: vi.fn(),
  });
  return { doc, chart, tooltip, appState, showAnalysisPly, view };
}

function allElements(chart) {
  const out = [];
  const walk = (el) => {
    out.push(el);
    el.children.forEach(walk);
  };
  walk(chart);
  return out;
}

// The plot is inset 9 screen px on each side (9 units in a 640px-wide chart).
function xOfIdx(idx, n) {
  return n === 1 ? 320 : 9 + (idx / (n - 1)) * (640 - 18);
}

afterEach(() => {
  delete globalThis.document;
});

// ---- Theme wiring (light/dark) ---------------------------------------------

describe("eval chart tooltip boundaries", () => {
  it.each([240, 640])("clamps both edge tooltips in a %ipx chart", (width) => {
    const { chart, tooltip, view } = setup();
    chart.rectWidth = width;
    tooltip.offsetWidth = 180;
    view.renderEvalChart(POINTS);
    for (const x of [0, width]) {
      chart.dispatch("mousemove", { clientX: x });
      const left = Number.parseFloat(tooltip.style.left);
      expect(left - 90).toBeGreaterThanOrEqual(0);
      expect(left + 90).toBeLessThanOrEqual(width);
    }
  });
});

describe("eval chart theme colours", () => {
  it("renders no hardcoded colours — every hue comes from CSS classes", () => {
    const { chart, view } = setup();
    view.renderEvalChart(POINTS);
    for (const el of allElements(chart)) {
      for (const [name, value] of el.attrs) {
        if (name === "stroke" || name === "fill" || name === "color") {
          expect(value).not.toMatch(/#|rgba?\(/i);
        }
      }
    }
  });

  it("paints the main line and markers from theme tokens in both themes", () => {
    const { chart, view } = setup();
    view.renderEvalChart(POINTS);
    const line = allElements(chart).find((el) => (el.attrs.get("class") || "").includes("eval-line"));
    expect(line.getAttribute("class")).toBe("eval-line");
    // The token exists in :root AND is retuned under [data-theme="dark"], so the
    // chart follows the theme instead of a fixed hex.
    expect(ALL_STYLES).toMatch(/\.eval-chart \.eval-line\s*\{[^}]*stroke: var\(--accent-strong\)/);
    expect(ALL_STYLES).toMatch(/:root\[data-theme="dark"\][\s\S]*--accent-strong:/);
    expect(ALL_STYLES).toMatch(/\.eval-chart \.eval-m-blunder\s*\{ color: var\(--danger\)/);
    expect(ALL_STYLES).toMatch(/:root\[data-theme="dark"\][\s\S]*--danger:/);
  });

  it("keeps the main-line stroke width constant when the SVG stretches", () => {
    const { chart, view } = setup();
    view.renderEvalChart(POINTS);
    const line = allElements(chart).find((el) => (el.attrs.get("class") || "").includes("eval-line"));
    expect(line.getAttribute("vector-effect")).toBe("non-scaling-stroke");
  });
});

// ---- Current-ply position state --------------------------------------------

describe("eval chart current-ply indicator", () => {
  it("centres the ring on the last ply, inside the frame", () => {
    const { chart, appState, view } = setup();
    view.renderEvalChart(POINTS);
    appState.analysisPly = POINTS[POINTS.length - 1].ply;
    view.updateEvalChartCursor();
    const ring = doc(chart).getElementById("eval-chart-cursor-dot");
    const cursor = doc(chart).getElementById("eval-chart-cursor");
    expect(ring.getAttribute("cx")).toBe(cursor.getAttribute("x1"));
    expect(Number(ring.getAttribute("cx"))).toBeCloseTo(640 - 9, 6);
  });

  it("marks the current ply with a dashed line and a ring (shape, not colour)", () => {
    const { chart, appState, view } = setup();
    view.renderEvalChart(POINTS);
    appState.analysisPly = 3;
    view.updateEvalChartCursor();

    const cursor = doc(chart).getElementById("eval-chart-cursor");
    const x = xOfIdx(2, 5); // ply 3 sits at index 2
    expect(cursor.getAttribute("x1")).toBe(String(x));
    expect(cursor.getAttribute("x2")).toBe(String(x));
    expect(cursor.getAttribute("stroke-dasharray")).toBe("3 3"); // pattern cue

    const ring = doc(chart).getElementById("eval-chart-cursor-dot");
    expect(ring.getAttribute("visibility")).toBe("visible");
    expect(ring.getAttribute("cx")).toBe(String(x));
  });

  it("hides the indicator when the current ply is not on the chart", () => {
    const { chart, appState, view } = setup();
    view.renderEvalChart(POINTS);
    appState.analysisPly = 0; // initial position: no point
    view.updateEvalChartCursor();

    const cursor = doc(chart).getElementById("eval-chart-cursor");
    const ring = doc(chart).getElementById("eval-chart-cursor-dot");
    expect(cursor.getAttribute("x1")).toBe("-10");
    expect(ring.getAttribute("visibility")).toBe("hidden");
  });
});

function doc(chart) {
  return chart.doc;
}

// ---- Mouse ------------------------------------------------------------------

describe("eval chart mouse behaviour", () => {
  it("hover shows the move, its eval in pawns, and classification as text", () => {
    const { chart, tooltip, view } = setup();
    view.renderEvalChart(POINTS);
    chart.dispatch("mousemove", { clientX: 480 }); // ratio .75 -> idx 3 (ply 4)
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.innerHTML).toContain("<b>Nc6</b>");
    expect(tooltip.innerHTML).toContain("−1.2");
    expect(tooltip.innerHTML).not.toContain("win chance");
    expect(tooltip.innerHTML).toContain("Mistake");
    expect(tooltip.innerHTML).toContain("?"); // glyph — a non-colour cue
    chart.dispatch("mouseleave");
    expect(tooltip.hidden).toBe(true);
  });

  it("click selects the nearest ply", () => {
    const { chart, showAnalysisPly, view } = setup();
    view.renderEvalChart(POINTS);
    chart.dispatch("click", { clientX: 480 });
    expect(showAnalysisPly).toHaveBeenCalledWith(4);
    chart.dispatch("click", { clientX: 0 });
    expect(showAnalysisPly).toHaveBeenCalledWith(1);
  });
});

// ---- Keyboard ---------------------------------------------------------------

describe("eval chart pointer focus", () => {
  it("never takes focus (so no tooltip lingers after the mouse leaves)", () => {
    const { chart, tooltip, view } = setup();
    view.renderEvalChart(POINTS);
    expect(chart.getAttribute("tabindex")).toBe(null);
    const down = chart.dispatch("mousedown");
    expect(down.preventDefault).toHaveBeenCalled();
    chart.dispatch("mousemove", { clientX: 160 });
    expect(tooltip.hidden).toBe(false);
    chart.dispatch("mouseleave");
    expect(tooltip.hidden).toBe(true);
  });

  it("fills White's advantage above the centre line and Black's below it", () => {
    const { chart, view } = setup();
    view.renderEvalChart(POINTS);
    const areas = allElements(chart).filter((el) => (el.getAttribute("class") || "").startsWith("eval-area "));
    expect(areas.map((el) => el.getAttribute("class"))).toEqual([
      "eval-area eval-area-white",
      "eval-area eval-area-black",
    ]);
    expect(areas[0].getAttribute("clip-path")).toBe("url(#eval-clip-white)");
    expect(areas[1].getAttribute("clip-path")).toBe("url(#eval-clip-black)");
  });
});

// ---- Helpers ----------------------------------------------------------------

describe("eval chart helpers", () => {
  it("evalChartNearestIndex maps a ratio to the nearest ply index", () => {
    const { view } = setup();
    expect(view.evalChartNearestIndex(POINTS, 0)).toBe(0);
    expect(view.evalChartNearestIndex(POINTS, 0.5)).toBe(2);
    expect(view.evalChartNearestIndex(POINTS, 1)).toBe(4);
    expect(view.evalChartNearestIndex([], 0.5)).toBe(-1);
  });

  it("evalChartTooltipHtml carries the full text readout", () => {
    const { view } = setup();
    const html = view.evalChartTooltipHtml(POINTS[3], { isCurrent: true });
    expect(html).toContain("2… <b>Nc6</b>");
    expect(html).toContain("−1.2");
    expect(html).toContain("Mistake");
    expect(html).toContain("current");
    expect(view.evalChartTooltipHtml(POINTS[0])).toContain("1. <b>e4</b> · +0.3");
    expect(
      view.evalChartTooltipHtml({ ply: 9, san: "Qh5", score_cp: null, bounded_score_cp: 1000, classification: "best" }),
    ).toContain("+M");
  });

  it("names the mate distance and a checkmate on the board", () => {
    const { view } = setup();
    expect(
      view.evalChartTooltipHtml({ ply: 78, san: "Qf4", score_cp: null, mate_in: 1, bounded_score_cp: 1000, classification: "best" }),
    ).toContain("· #1");
    const mated = view.evalChartTooltipHtml({ ply: 79, san: "Qxf4#", score_cp: 100000, mate_in: null, bounded_score_cp: 1000, classification: "best" });
    expect(mated).toContain("· 1-0");
    expect(mated).not.toContain("1000");
    expect(
      view.evalChartTooltipHtml({ ply: 80, san: "Qxf2#", score_cp: -100000, mate_in: null, bounded_score_cp: -1000, classification: "best" }),
    ).toContain("· 0-1");
  });
});
