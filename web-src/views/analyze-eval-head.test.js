// Evaluation card head (chip + win meter) and the live whole-game progress chart
// (web-src/views/analyze.js). A tiny stub document: only the ids these paths read.
import { afterEach, describe, expect, it } from "vitest";

import { createAnalyzeView } from "./analyze.js";

function el(extra = {}) {
  const classes = new Set();
  return {
    textContent: "",
    get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
    dataset: {},
    style: { setProperty() {} },
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    ...extra,
  };
}

function setup() {
  const head = el();
  const ids = {
    "analysis-chart-caption": el({ parentElement: head }),
    "analysis-eval-card": el(),
    "engine-head-eval": el(),
    "engine-eval-bar-white": el({ style: { height: "" } }),
    "eval-chart-live": el(),
    "analysis-eval-live": el(),
    "eval-chart-cursor": el({ setAttribute() {} }),
  };
  const fill = el({ style: { width: "" } });
  globalThis.document = {
    getElementById: (id) => ids[id] || null,
    querySelector: (sel) => (sel === "#analysis-eval-meter > i" ? fill : null),
  };
  const appState = { evalChartPoints: [], analysisPly: 0 };
  const view = createAnalyzeView({
    appState,
    START_FEN: "",
    showAnalysisPly: () => {},
    selectAnalysisNode: async () => {},
    revealAnalysisResults: () => {},
  });
  return { view, ids, head, fill, appState };
}

afterEach(() => {
  delete globalThis.document;
});

describe("Evaluation head", () => {
  it("shows the analysed game's eval as a chip in the winning side's colours, with the meter", () => {
    const { view, ids, head, fill, appState } = setup();
    appState.evalChartPoints = [{ ply: 1, score_cp: 250 }];
    appState.analysisPly = 1;
    view.updateEvalChartCursor();
    expect(ids["analysis-chart-caption"].textContent).toBe("+2.50");
    expect(ids["analysis-chart-caption"].dataset.side).toBe("white");
    expect(head.classList.contains("has-eval")).toBe(true);
    expect(parseInt(fill.style.width, 10)).toBeGreaterThan(70);
  });

  it("is empty (no fabricated number) where nothing has been evaluated", () => {
    const { view, ids, head, fill } = setup();
    view.updateEvalChartCursor();
    expect(ids["analysis-chart-caption"].textContent).toBe("");
    expect(head.classList.contains("has-eval")).toBe(false);
    expect(fill.style.width).toBe("50%");
  });

  it("never substitutes a saved score while the live engine starts", () => {
    const { view, ids, fill, appState } = setup();
    appState.evalChartPoints = [{ ply: 1, score_cp: -1259 }];
    appState.analysisPly = 1;
    ids["analysis-eval-card"].classList.toggle("is-engine", true);
    ids["engine-head-eval"].textContent = "...";
    view.updateEvalChartCursor();
    expect(ids["analysis-chart-caption"].textContent).toBe("");
    ids["engine-head-eval"].textContent = "−0.40";
    ids["engine-head-eval"].dataset.side = "black";
    ids["engine-eval-bar-white"].style.height = "46%";
    view.paintEvalHead();
    expect(ids["analysis-chart-caption"].textContent).toBe("−0.40");
    expect(ids["analysis-chart-caption"].dataset.side).toBe("black");
    expect(fill.style.width).toBe("46%");
    ids["engine-head-eval"].dataset.pending = "true";
    appState.analysisPly = 2;
    appState.evalChartPoints = [{ ply: 2, score_cp: -1259 }];
    view.updateEvalChartCursor();
    expect(ids["analysis-chart-caption"].textContent).toBe("−0.40");
    expect(fill.style.width).toBe("46%");
    expect(ids["analysis-chart-caption"].dataset.pending).toBe("true");
    ids["analysis-eval-card"].classList.toggle("is-engine", false);
    view.paintEvalHead();
    expect(ids["analysis-chart-caption"].textContent).toBe("−12.59");
  });
});

describe("live whole-game progress chart", () => {
  it("plots each result at its position as it lands, out of order, with a progress front", async () => {
    const { view, ids } = setup();
    const onResult = view.liveEvalChart(["p0", "p1", "p2", "p3"]);
    const svg = ids["eval-chart-live"];
    expect(String(svg.innerHTML)).toContain("eval-axis");
    expect(String(svg.innerHTML)).not.toContain("polyline");
    onResult("p2", { score_cp: 120 });
    onResult("p0", { score_cp: 0 });
    onResult("unknown", { score_cp: 999 });
    await new Promise((r) => setTimeout(r, 30));
    const points = /points="([^"]+)"/.exec(svg.innerHTML)[1].split(" ");
    expect(points).toHaveLength(2);
    expect(points[0].startsWith("0.0,")).toBe(true);
    // The front marks the furthest finished position (p2 of 0..3).
    expect(String(svg.innerHTML)).toMatch(/class="eval-front" x1="426.7"/);
  });

  it("animates Maia's read on the finished curve: a sweep up to its front", async () => {
    const { view, ids } = setup();
    const live = view.liveEvalChart(["p0", "p1", "p2"]);
    ["p0", "p1", "p2"].forEach((p) => live(p, { score_cp: 40 }));
    live.phase("maia", 1, 2);
    await new Promise((r) => setTimeout(r, 30));
    const html = ids["eval-chart-live"].innerHTML;
    expect(String(html)).not.toContain("eval-front");
    expect(String(html)).toMatch(/class="eval-maia-front" x1="320.0"/);
    // Only the part of the curve Maia has read is recoloured.
    expect(/class="eval-maia-line" points="([^"]+)"/.exec(html)[1].split(" ")).toHaveLength(2);
    live.phase("maia-load");
    await new Promise((r) => setTimeout(r, 30));
    expect(String(ids["eval-chart-live"].innerHTML)).not.toMatch(/eval-maia-(line|front)/);
  });

  it("maps mates to the edge of the chart instead of a flat line", async () => {
    const { view, ids } = setup();
    const onResult = view.liveEvalChart(["a", "b"]);
    onResult("a", { score_cp: null, mate_in: 3 });
    onResult("b", { score_cp: null, mate_in: -2 });
    await new Promise((r) => setTimeout(r, 30));
    const ys = /points="([^"]+)"/.exec(ids["eval-chart-live"].innerHTML)[1].split(" ").map((p) => Number(p.split(",")[1]));
    expect(ys[0]).toBeLessThan(20);
    expect(ys[1]).toBeGreaterThan(76);
  });

  it("maps the job's real phases and clears the previous game's caption", async () => {
    const { view, ids, appState } = setup();
    appState.evalChartPoints = [{ ply: 1, score_cp: 250 }];
    appState.analysisPly = 1;
    view.updateEvalChartCursor();
    const live = view.liveEvalChart(["p0", "p1"]);
    expect(ids["analysis-chart-caption"].textContent).toBe("");
    for (const [jobPhase, graphPhase] of [["maia-load", "maia-load"], ["maia-inference", "maia"],
      ["maia-traps", "maia"], ["classifying", "saving"]]) {
      live.phase(jobPhase, 1, 2);
      await new Promise((r) => setTimeout(r, 30));
      expect(ids["analysis-eval-live"].dataset.phase).toBe(graphPhase);
    }
  });
});
