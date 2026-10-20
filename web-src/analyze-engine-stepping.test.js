import { html } from "./html.js";
import { describe, expect, it, vi } from "vitest";
import { formatEngineEval } from "./engine-eval.js";
import { readFileSync } from "node:fs";
import { appSource } from "./test-app-source.js";

const source = appSource();

function widgetHarness() {
  const deps = { html,
    setEngineBestArrow: vi.fn(), localGameOver: () => null,
    activeViewName: () => "analyze", effectiveStockfishDepth: () => 16,
    createSharedEvaluationProvider: vi.fn(), appState: {}, boards: {}, START_FEN: "start",
    explorerEvalEngine: { repaint: vi.fn() }, getAnalyzeSession: () => null, formatEngineEval,
  };
  const widgetSource = readFileSync(new URL("./controllers/engine-widget.js", import.meta.url), "utf8");
  const code = widgetSource.slice(widgetSource.indexOf("class EngineWidget {"));
  const Widget = new Function(...Object.keys(deps), `return (${code.trim()});`)(...Object.values(deps));
  const widget = new Widget();
  widget.open = true;
  widget.lastFen = "current w - - 0 1";
  widget.currentFen = () => widget.lastFen;
  widget.evalHead = { textContent: "-1.92", dataset: { side: "black" } };
  widget.evalBarWhite = { style: { height: "33%" } };
  widget.depthReadout = {
    textContent: "16 / 16",
    dataset: {},
    style: { setProperty() {} },
    title: "",
  };
  widget.pvsEl = { get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); } };
  return { widget, arrow: deps.setEngineBestArrow };
}

describe("Analyze engine stepping", () => {
  it("keeps the last live score and meter during repeated search warmups", () => {
    const { widget } = widgetHarness();
    widget._clearAnalysisView();
    widget._clearAnalysisView();
    expect(widget.evalHead.textContent).toBe("-1.92");
    expect(widget.evalHead.dataset.side).toBe("black");
    expect(widget.evalHead.dataset.pending).toBe("true");
    expect(widget.evalBarWhite.style.height).toBe("33%");
    expect(widget.depthReadout.textContent).toBe("0 / ?");
    expect(widget.depthReadout.dataset.d).toBe("0");
    expect(widget.depthReadout.title).toBe("Search depth 0");
    expect(String(widget.pvsEl.innerHTML)).toContain("Calculating…");
    // MultiPV can deliver rank 2 first, leaving a scoreless rank-1 slot.
    widget._renderEvalBar({ score_cp: null, mate_in: null });
    expect(widget.evalHead.textContent).toBe("-1.92");
    expect(widget.evalHead.dataset.pending).toBe("true");
    widget._renderEvalBar({ score_cp: 40 });
    expect(widget.evalHead.textContent).toBe("+0.40");
    expect(widget.evalHead.dataset.pending).toBeUndefined();
  });

  it("searches exactly the lines it shows, plus the coach's alternative while it is on", async () => {
    const { widget } = widgetHarness();
    // The card's Line −/+ is the whole contract with the engine: at 1 line Stockfish is
    // asked for MultiPV 1 (it used to be forced to MultiPV 2 on Analyze, doubling the
    // nodes of every search for a line the card never drew) — unless the coach's engine
    // review is on, which reads the best alternative from this same search.
    const sent = [];
    const engine = {
      open: vi.fn(async (req) => { sent.push(["open", req.multipv]); return { session_id: "s", fen: req.fen, pvs: [], running: true }; }),
      update: vi.fn(async (req) => { sent.push(["update", req.multipv]); return { session_id: "s", fen: req.fen, pvs: [], running: true }; }),
      snapshot: () => null,
    };
    widget.engine = engine;
    widget.engineDepth = 16;
    widget.el = { hidden: true, classList: { add() {}, remove() {}, contains: () => false } };
    widget.lastFen = "current w - - 0 1";
    // Reviews off (the harness has no session): the search is the shown lines.
    await widget.openForCurrent();
    await widget._setMultipv(3);
    expect(sent).toEqual([["open", 1], ["update", 3]]);
    expect(widget.multipv).toBe(3);
  });

  it("does not paint another FEN's score or arrow", () => {
    const { widget, arrow } = widgetHarness();
    widget._renderSnapshot({ fen: "old b - - 0 1", session_id: "old", pvs: [{ score_cp: -1259 }] });
    expect(widget.evalHead.textContent).toBe("-1.92");
    expect(arrow).not.toHaveBeenCalled();
  });

  it.each(["next", "end", "prev", "start"])("%s at its boundary never reselects the board or clears a settled arrow", async (kind) => {
    const { widget, arrow } = widgetHarness();
    const root = { id: "root", children: [], parent: null };
    const end = { id: "m1", children: [], parent: root };
    root.children.push(end);
    const current = kind === "next" || kind === "end" ? end : root;
    const appState = { analysisCurrentNodeId: current.id, analysisTree: { root, byId: new Map([[root.id, root], [end.id, end]]) } };
    const select = vi.fn(async () => {
      // The coach clears the arrow, but an unchanged FEN cannot restart the widget.
      arrow(null);
      await widget.onBoardChanged();
    });
    const start = source.indexOf("async function analysisTreeNav(");
    const code = source.slice(start, source.indexOf("\nfunction resetAnalysisVariations", start));
    const nav = new Function("appState", "ensureAnalyzeView", "selectAnalysisNode", `${code}; return analysisTreeNav;`)(appState, async () => ({}), select);
    await nav(kind);
    await nav(kind);
    expect(select).not.toHaveBeenCalled();
    expect(arrow).not.toHaveBeenCalled();
    if (kind === "next") {
      appState.analysisCurrentNodeId = "root";
      await nav("next");
      expect(select).toHaveBeenCalledWith("m1");
    }
  });
});

// The keyboard row under the board: Home/End jump to the ends of the line, the
// way the board-bar's first/last buttons do (one key hold steps the whole game).
describe("Analyze keyboard: Home / End", () => {
  it("routes Home and End to the ends of the line, and to Build's own ends", () => {
    const i = source.indexOf('if (event.key === "Home" || event.key === "End") {');
    expect(i).toBeGreaterThan(0);
    const block = source.slice(i, i + 420);
    expect(block).toMatch(/analysisTreeNav\(event\.key === "Home" \? "start" : "end"\)/);
    expect(block).toMatch(/buildGoRoot\(\)/);
    expect(block).toMatch(/buildGoToEnd\(\)/);
  });
});
