import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";

const source = appSource();

function widgetHarness() {
  const deps = {
    setEngineBestArrow: vi.fn(), localGameOver: () => null,
    activeViewName: () => "analyze",
    explorerEvalEngine: { repaint: vi.fn() }, analyzeSession: null,
  };
  const code = source.slice(source.indexOf("class EngineWidget {"), source.indexOf("const engineWidget ="));
  const Widget = new Function(...Object.keys(deps), `return (${code.trim()});`)(...Object.values(deps));
  const widget = new Widget();
  widget.open = true;
  widget.lastFen = "current w - - 0 1";
  widget.currentFen = () => widget.lastFen;
  widget.evalHead = { textContent: "-1.92", dataset: { side: "black" } };
  widget.evalBarWhite = { style: { height: "33%" } };
  widget.depthReadout = { textContent: "16 / 16" };
  widget.pvsEl = { innerHTML: "" };
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
    expect(widget.pvsEl.innerHTML).toContain("Calculating…");
    // MultiPV can deliver rank 2 first, leaving a scoreless rank-1 slot.
    widget._renderEvalBar({ score_cp: null, mate_in: null });
    expect(widget.evalHead.textContent).toBe("-1.92");
    expect(widget.evalHead.dataset.pending).toBe("true");
    widget._renderEvalBar({ score_cp: 40 });
    expect(widget.evalHead.textContent).toBe("+0.40");
    expect(widget.evalHead.dataset.pending).toBeUndefined();
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
