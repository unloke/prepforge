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
    return { left: 0, top: 0, width: this.rectWidth, height: this.rectHeight ?? 96 };
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
  const peek = vi.fn();
  const view = createAnalyzeView({
    appState,
    START_FEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    showAnalysisPly,
    selectAnalysisNode: vi.fn(async () => {}),
    revealAnalysisResults: vi.fn(),
    peek,
  });
  return { doc, chart, tooltip, appState, showAnalysisPly, peek, view };
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

// The plies run edge to edge across the 640-unit chart.
function xOfIdx(idx, n) {
  return n === 1 ? 320 : (idx / (n - 1)) * 640;
}

// Win% to chart units, mirroring evalChartYOf (analyze.js): a 9px inset keeps a
// marker at either extreme inside the frame, and the rest is the plotted band.
// Matched to the fake chart's measured 96px height, so the inset converts 1:1.
function yOfWinPct(pct) {
  const padY = Math.min((9 * 96) / 96, 96 / 4);
  return padY + (1 - pct / 100) * (96 - 2 * padY);
}

afterEach(() => {
  delete globalThis.document;
});

// ---- Theme wiring (light/dark) ---------------------------------------------

describe("eval chart tooltip boundaries", () => {
  // The readout takes the side of the plot away from the pointer and the half
  // of the band away from the point, so neither the column being pointed at nor
  // the curve it names is ever under it.
  it.each([240, 640])("keeps the readout inside a %ipx chart and off the cursor", (width) => {
    const { chart, tooltip, view } = setup();
    chart.rectWidth = width;
    tooltip.offsetWidth = 180;
    tooltip.offsetHeight = 23;
    view.renderEvalChart(POINTS);
    for (const x of [0, width / 2, width]) {
      chart.dispatch("pointermove", { pointerType: "mouse", clientX: x });
      const left = Number.parseFloat(tooltip.style.left);
      const right = left + Math.min(180, Number.parseFloat(tooltip.style.maxWidth));
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(width);
      // The cursor's column is clear: the readout opens on the far side, or is
      // clipped short of it when that side is the only one with room.
      expect(x >= left && x <= right).toBe(false);
      if (x < width / 2) expect(left).toBeGreaterThan(x);
      else if (x > width / 2) expect(right).toBeLessThanOrEqual(x);
    }
  });

  // A phone's graph is 276px wide and the longest readout is 166px: at dead
  // centre neither side has room for it, and clamping the box back inside the
  // plot slid it across the pointer. It is clipped to the side's room instead.
  it("never covers the pointer when the readout is wider than either side", () => {
    const width = 276;
    const tipWidth = 166;
    const { chart, tooltip, view } = setup();
    chart.rectWidth = width;
    tooltip.offsetWidth = tipWidth;
    tooltip.offsetHeight = 18;
    view.renderEvalChart(POINTS);
    for (let x = 0; x <= width; x += 2) {
      chart.dispatch("pointermove", { pointerType: "mouse", clientX: x });
      const left = Number.parseFloat(tooltip.style.left);
      const maxWidth = Number.parseFloat(tooltip.style.maxWidth);
      const right = left + Math.min(tipWidth, maxWidth);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(width);
      expect(x >= left && x <= right).toBe(false);
    }
  });

  it("takes the half of the band the curve is not in", () => {
    const height = 96;
    const top = (points) => {
      const { chart, tooltip, view } = setup();
      chart.rectWidth = 640;
      tooltip.offsetWidth = 180;
      tooltip.offsetHeight = 23;
      view.renderEvalChart(points);
      chart.dispatch("pointermove", { pointerType: "mouse", clientX: 320 });
      return Number.parseFloat(tooltip.style.top);
    };
    // White is winning by a rook: the curve rides the top, the readout the bottom.
    expect(top(POINTS.map((p) => ({ ...p, score_cp: 500, bounded_score_cp: 500 })))).toBeGreaterThan(height / 2);
    // White is losing by a rook: the curve sits at the bottom, the readout on top.
    expect(top(POINTS.map((p) => ({ ...p, score_cp: -500, bounded_score_cp: -500 })))).toBeLessThan(height / 2);
  });
});

describe("eval chart sizing", () => {
  it("adds analysis samples without replaying the graph entrance", () => {
    const { chart, view } = setup();
    for (let count = 1; count <= POINTS.length; count++) {
      view.renderEvalChart(POINTS.slice(0, count));
      expect(chart.getAttribute('class') || '').not.toContain('is-entering');
      expect(chart.querySelectorAll('.eval-line')).toHaveLength(1);
    }
    expect(chart.listeners.animationend).toBeUndefined();
  });

  it("draws a short phone chart once instead of redrawing itself forever", () => {
    const { chart, appState, view } = setup();
    chart.rectHeight = 30;
    appState.evalChartPoints = POINTS;
    expect(() => view.renderEvalChart(POINTS)).not.toThrow();
    expect(chart.querySelectorAll(".eval-marker").length).toBeGreaterThan(0);
  });
});

describe("evaluation win meter", () => {
  it("draws an empty track, not a mid-width fill, while there is no number", () => {
    // A half-full bar with no figures beside it reads as a real 50/50 eval,
    // so the fill starts at zero until a number paints it.
    expect(ALL_STYLES).toMatch(/\.ev-meter > i \{[^}]*transform: scaleX\(0\)/);
    expect(ALL_STYLES).not.toMatch(/\.ev-meter > i \{[^}]*transform: scaleX\(0\.5\)/);
  });

  it("lands its new share within the stepping budget", () => {
    // Arrow-stepping is the repeated action here: a 300ms slide left the bar
    // trailing its own number by a third of a second on every keypress.
    const rule = /\.ev-meter > i \{([^}]*)\}/.exec(ALL_STYLES)[1];
    expect(rule).toMatch(/transition:\s*transform var\(--dur-fast\)/);
    // The live engine still jumps: it repaints many times a second.
    expect(ALL_STYLES).toMatch(/#analysis-eval-card\.is-engine \.ev-meter > i \{\s*transition: none;/);
  });
});

describe("report grades", () => {
  it("colours each grade's glyph with its text-safe token, as the move list does", () => {
    expect(CHART_STYLES).toMatch(/\.g-brilliant \.rp-glyph \{ color: var\(--brilliant-text\); \}/);
    expect(CHART_STYLES).toMatch(/\.g-inaccuracy \.rp-glyph \{ color: var\(--inaccuracy-text\); \}/);
    expect(CHART_STYLES).toMatch(/\.rp-n \{[^}]*font-variant-numeric: tabular-nums/);
  });

  it("gives a grade glyph a text-safe colour, not the fill", () => {
    // --brilliant fills a dot or a bar; as 13px text it is 4:1 on the panel,
    // under AA ("!!" measured at 4:1 in the grade tally). The same applies to
    // the amber, which is 2.9:1 against white — hence its own text token.
    expect(CHART_STYLES).toMatch(/\.mtree-move\.cls-brilliant \.mtree-glyph \{ color: var\(--brilliant-text\)/);
    expect(CHART_STYLES).toMatch(/\.mtree-move\.cls-inaccuracy \.mtree-glyph \{ color: var\(--inaccuracy-text\)/);
    expect(STYLES).toMatch(/--inaccuracy-text:/);
  });
});

describe("coach note", () => {
  it("keeps the verdict readable and scrolls text inside its reserved row", () => {
    expect(ALL_STYLES).toMatch(/\.coach-prose \{[^}]*font-size: 16px/);
    expect(ALL_STYLES).toMatch(/\.coach-prose \{[^}]*min-height: 0/);
    expect(ALL_STYLES).toMatch(/\.coach-prose \{[^}]*overflow-y: auto/);
  });

  it("reserves rows for the controls, verdict and Humans, but not for the prep", () => {
    // The prep row takes its line only when a book-departure note exists: a
    // reserved track put 22px + gaps of empty panel between the Humans pills and
    // the Evaluation card on every other ply.
    const rule = /\.coach-card \{([^}]*)\}/.exec(ALL_STYLES)[1];
    expect(rule).toMatch(/--coach-head: var\(--control-h-sm\)/);
    expect(rule).toMatch(/grid-template-rows: var\(--coach-head\) minmax\(0, 1fr\) var\(--coach-foot\) auto auto/);
    // The review bar's row counts only when a reviewed game shows it.
    expect(rule).toMatch(/height: calc\(var\(--coach-head\) \+ var\(--coach-line\) \* 3 \+ 4px \+ var\(--coach-foot\) \+ var\(--coach-gap\) \* 2 \+ var\(--coach-review\)\)/);
    expect(rule).toMatch(/--coach-review: 0px/);
    // The rows are spaced by their own top margin, never by a grid gap: a gap is
    // charged after the hidden prep row too, and lands as dead space below the
    // Humans row.
    expect(rule).toMatch(/gap: 0;/);
    expect(ALL_STYLES).toMatch(/\.coach-card > \.coach-prose \{ margin: var\(--coach-gap\) 0; \}/);
  });

  it("puts the phone review bar on the coach's first row, so the verdict keeps its lines", () => {
    // A row of its own under the Humans pills left the verdict 0px on a 660px phone.
    expect(ALL_STYLES).toMatch(/#analysis-explain > \.coach-review \{ order: -1; gap: 0; height: 44px; \}/);
    expect(ALL_STYLES).toContain("#analysis-explain:has(> .coach-review:not([hidden])) .cc-head { display: contents; }");
    expect(ALL_STYLES).not.toContain("margin: 0 48px -50px 0");
  });
});

describe("the panel's one filled action", () => {
  it("keeps Analyze the accent; the report's handoff is a plain button", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const handoff = html.match(/<button[^>]*id="create-repertoire-from-game"/)[0];
    expect(handoff).not.toMatch(/primary/);
    expect(ALL_STYLES).not.toMatch(/#run-analysis \{[^}]*background:\s*transparent/);
  });
});

describe("score sheet ink", () => {
  it("paints the selected move in the accent's ink, glyph included", () => {
    // The mainline ink rule and the grade-glyph rules both out-ranked the
    // shared tree's .is-current colour, so on this grid the selected move read
    // --text on the accent fill (2.9:1 at 1440x900) and its glyph came out in
    // --text on the same fill. Both now take the accent's ink.
    const row = CHART_STYLES.match(
      /\.moves-grid \.mtree-line\.is-main > \.mtree-move\.is-current \{([^}]+)\}/,
    )?.[1] || "";
    expect(row).toMatch(/color:\s*var\(--accent-ink\)/);
    expect(CHART_STYLES).toMatch(
      /\.moves-grid \.mtree-line\.is-main > \.mtree-move\.is-current \.mtree-glyph \{ color: inherit; \}/,
    );
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

  it("fills White's and Black's areas from the theme's own piece colours", () => {
    // Hardcoded hexes made the dark theme draw a glaring white band; the
    // tokens carry a dark-theme value for each side. White's wedge is the
    // panel tone (the light one in the dark theme), so it stands clear of the
    // field the way the dark wedge does.
    expect(ALL_STYLES).toMatch(/\.eval-chart \.eval-area-white\s*\{[^}]*fill: var\(--eval-area-white\)/);
    expect(ALL_STYLES).toMatch(/\.eval-chart \.eval-area-black\s*\{[^}]*fill: var\(--eval-side-black\)/);
    expect(ALL_STYLES).toMatch(/\.eval-chart \{[^}]*--eval-area-white: var\(--panel\)/);
    // Round 5: a soft mix toward the card (Lichess's dark chart), still read
    // from the theme's own white-side token.
    expect(ALL_STYLES).toMatch(/:root\[data-theme="dark"\] \.eval-chart \{[^}]*--eval-area-white: color-mix\(in srgb, var\(--eval-side-white\) \d+%, var\(--panel\)\)/);
    expect(ALL_STYLES).not.toMatch(/\.eval-area-(white|black)\s*\{[^}]*fill: #/);
  });

  it("keeps the field a quiet step off the card, not a tone of its own", () => {
    // A mid-grey field outweighed both areas: the curve read at 2.2:1 against
    // it while the wedges read at 3.4–3.9. Mixed mostly out of the card's own
    // tone the field recedes, and the curve leads.
    const field = ALL_STYLES.match(/\.eval-chart \{[^}]*--eval-field: ([^;]+);/)?.[1] || "";
    expect(field).toContain("var(--panel) 84%");
    const dark = ALL_STYLES.match(/:root\[data-theme="dark"\] \.eval-chart \{[^}]*--eval-field: ([^;]+);/)?.[1] || "";
    expect(dark).toContain("var(--panel) 84%");
    expect(dark).toContain("var(--eval-side-white)");
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
  it("centres the ring on the last ply, on the right edge", () => {
    const { chart, appState, view } = setup();
    view.renderEvalChart(POINTS);
    appState.analysisPly = POINTS[POINTS.length - 1].ply;
    view.updateEvalChartCursor();
    const ring = doc(chart).getElementById("eval-chart-cursor-dot");
    const cursor = doc(chart).getElementById("eval-chart-cursor");
    expect(ring.getAttribute("cx")).toBe(cursor.getAttribute("x1"));
    expect(Number(ring.getAttribute("cx"))).toBeCloseTo(640, 6);
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
    expect(cursor.getAttribute("visibility")).toBe("visible");

    const ring = doc(chart).getElementById("eval-chart-cursor-dot");
    expect(ring.getAttribute("visibility")).toBe("visible");
    // Same win% sigmoid the view uses, mapped onto the plot band.
    const cp = POINTS[2].score_cp;
    const pct = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, cp)))) - 1);
    const y = yOfWinPct(pct);
    expect(ring.getAttribute("cx")).toBe(String(x));
    expect(Number(ring.getAttribute("cy"))).toBeCloseTo(y, 6);
  });

  it("hides the indicator when the current ply is not on the chart", () => {
    const { chart, appState, view } = setup();
    view.renderEvalChart(POINTS);
    appState.analysisPly = 0; // initial position: no point
    view.updateEvalChartCursor();

    const cursor = doc(chart).getElementById("eval-chart-cursor");
    const ring = doc(chart).getElementById("eval-chart-cursor-dot");
    expect(cursor.getAttribute("x1")).toBe("-10");
    // The SVG overflows its frame, so the parked line must be hidden too.
    expect(cursor.getAttribute("visibility")).toBe("hidden");
    expect(ring.getAttribute("visibility")).toBe("hidden");
  });
});

function doc(chart) {
  return chart.doc;
}

// ---- Mouse ------------------------------------------------------------------

describe("eval chart mouse behaviour", () => {
  it("previews the hovered move's grade without selecting it", () => {
    const { chart, appState, peek, showAnalysisPly, view } = setup();
    appState.analysis = { moves: [{ ply: 4, fen_after: "hovered position", uci: "b8c6", classification: "mistake" }] };
    view.renderEvalChart(POINTS);
    chart.dispatch("pointermove", { pointerType: "mouse", clientX: 480 });
    expect(peek).toHaveBeenLastCalledWith({ fen: "hovered position", lastMove: "b8c6", classification: "mistake" });
    expect(showAnalysisPly).not.toHaveBeenCalled();
    chart.dispatch("pointerleave", { pointerType: "mouse" });
    expect(peek).toHaveBeenLastCalledWith(null);
  });

  it("hover shows the move, its eval in pawns, and classification as text", () => {
    const { chart, tooltip, view } = setup();
    view.renderEvalChart(POINTS);
    chart.dispatch("pointermove", { pointerType: "mouse", clientX: 480 }); // ratio .75 -> idx 3 (ply 4)
    expect(tooltip.hidden).toBe(false);
    expect(String(tooltip.innerHTML)).toContain("<b>Nc6</b>");
    expect(String(tooltip.innerHTML)).toContain("−1.2");
    expect(String(tooltip.innerHTML)).not.toContain("win chance");
    expect(String(tooltip.innerHTML)).toContain("Mistake");
    expect(String(tooltip.innerHTML)).toContain("?"); // glyph — a non-colour cue
    chart.dispatch("pointerleave", { pointerType: "mouse" });
    expect(tooltip.hidden).toBe(true);
  });

  it("a finger scrubs with the tooltip up and lifting it hides the tooltip", () => {
    const { chart, tooltip, showAnalysisPly, view } = setup();
    view.renderEvalChart(POINTS);
    chart.dispatch("pointerdown", { pointerType: "touch", clientX: 480 });
    expect(tooltip.hidden).toBe(false);
    expect(showAnalysisPly).toHaveBeenCalledWith(4);
    chart.dispatch("pointermove", { pointerType: "touch", clientX: 0 });
    expect(showAnalysisPly).toHaveBeenCalledWith(1);
    chart.dispatch("pointerup", { pointerType: "touch" });
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
    chart.dispatch("pointermove", { pointerType: "mouse", clientX: 160 });
    expect(tooltip.hidden).toBe(false);
    chart.dispatch("pointerleave", { pointerType: "mouse" });
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
    expect(String(html)).toContain("2… <b>Nc6</b>");
    expect(String(html)).toContain("−1.2");
    expect(String(html)).toContain("Mistake");
    expect(String(html)).toContain("current");
    expect(String(view.evalChartTooltipHtml(POINTS[0]))).toContain("1. <b>e4</b> · +0.3");
    expect(
      String(view.evalChartTooltipHtml({ ply: 9, san: "Qh5", score_cp: null, bounded_score_cp: 1000, classification: "best" })),
    ).toContain("+M");
  });

  it("names the mate distance and a checkmate on the board", () => {
    const { view } = setup();
    expect(
      String(view.evalChartTooltipHtml({ ply: 78, san: "Qf4", score_cp: null, mate_in: 1, bounded_score_cp: 1000, classification: "best" })),
    ).toContain("· #1");
    const mated = view.evalChartTooltipHtml({ ply: 79, san: "Qxf4#", score_cp: 100000, mate_in: null, bounded_score_cp: 1000, classification: "best" });
    expect(String(mated)).toContain("· 1-0");
    expect(String(mated)).not.toContain("1000");
    expect(
      String(view.evalChartTooltipHtml({ ply: 80, san: "Qxf2#", score_cp: -100000, mate_in: null, bounded_score_cp: -1000, classification: "best" })),
    ).toContain("· 0-1");
  });
});
