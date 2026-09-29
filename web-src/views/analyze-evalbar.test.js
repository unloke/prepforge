import { afterEach, describe, expect, it } from "vitest";

import { createAnalyzeView } from "./analyze.js";

// Characterization for the ui-prototype-v2 board-side eval bar on Analyze:
//  - it reads the SAME real eval-graph points the win-chance chart uses;
//  - exact-ply match only — no point for the current ply hides the bar (never
//    a fabricated or stale eval);
//  - the white share lands in --white-share (orientation-agnostic) with a
//    plain-text % readout.

class FakeEl {
  constructor(id) {
    this.id = id;
    this.attrs = new Map();
    this.style = {
      setProperty: (k, v) => {
        this.style[k] = v;
      },
      getPropertyValue: (k) => this.style[k] ?? "",
    };
    this.hidden = false;
    this._innerHTML = "";
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  set innerHTML(v) {
    this._innerHTML = v;
  }
  get innerHTML() {
    return this._innerHTML;
  }
  appendChild() {}
}

function setup({ points, ply }) {
  const byId = new Map();
  const register = (id) => {
    const el = new FakeEl(id);
    byId.set(id, el);
    return el;
  };
  const cursor = register("eval-chart-cursor");
  register("eval-chart-cursor-dot");
  const bar = register("analysis-evalbar");
  register("analysis-evalbar-white");
  register("analysis-evalbar-text");
  globalThis.document = {
    getElementById: (id) => byId.get(id) || null,
    createElementNS: () => new FakeEl("ns"),
    createElement: () => new FakeEl("el"),
    querySelector: () => null,
  };
  const appState = { analysisPly: ply, evalChartPoints: points };
  const view = createAnalyzeView({
    appState,
    escapeHtml: (s) => String(s),
    START_FEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    showAnalysisPly: async () => {},
    selectAnalysisNode: async () => {},
    revealAnalysisResults: () => {},
  });
  return { view, cursor, bar, appState };
}

afterEach(() => {
  globalThis.document = undefined;
});

describe("analyze board eval bar", () => {
  it("updates from the real eval point at the current ply", () => {
    const points = [
      { ply: 1, san: "e4", score_cp: 30, bounded_score_cp: 30, classification: "best" },
      { ply: 2, san: "e5", score_cp: -400, bounded_score_cp: -400, classification: "blunder" },
    ];
    const { view, bar } = setup({ points, ply: 2 });
    view.updateEvalChartCursor();
    expect(bar.hidden).toBe(false);
    // -400cp → ~19% white share via the Lichess sigmoid (1/(1+e^(0.00368208·400))).
    expect(bar.style.getPropertyValue("--white-share")).toBe("19%");
  });

  it("hides when no scored point exists for the current ply", () => {
    const points = [{ ply: 1, san: "e4", score_cp: 30, bounded_score_cp: 30, classification: "best" }];
    const { view, bar } = setup({ points, ply: 3 });
    view.updateEvalChartCursor();
    expect(bar.hidden).toBe(true);
  });

  it("hides when there is no analysis at all", () => {
    const { view, bar } = setup({ points: [], ply: 0 });
    view.updateEvalChartCursor();
    expect(bar.hidden).toBe(true);
  });
});
