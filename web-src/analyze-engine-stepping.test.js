import { html } from "./html.js";
import { describe, expect, it, vi } from "vitest";
import { formatEngineEval } from "./engine-eval.js";
import { pvSan } from "./chess-local.js";
import { readFileSync } from "node:fs";
import { appSource } from "./test-app-source.js";
import { createPassFeed } from "./controllers/engine-pass-feed.js";

const source = appSource();
const selectionSource = readFileSync(new URL("./controllers/analyze-selection.js", import.meta.url), "utf8");

function widgetHarness({ coachOn = false } = {}) {
  const deps = { html,
    setEngineBestArrow: vi.fn(), localGameOver: () => null, pvSan,
    activeViewName: () => "analyze", effectiveStockfishDepth: () => 16,
    createSharedEvaluationProvider: vi.fn(), appState: {}, boards: {}, START_FEN: "start",
    explorerEvalEngine: { repaint: vi.fn() }, formatEngineEval,
    getAnalyzeSession: () => (coachOn ? { positionCoach: { enabled: true, onWidgetSnapshot: vi.fn() } } : null),
    // The full net is here: no unlock row to paint.
    paintUnlocks: () => {}, createPassFeed,
    // No whole-game pass: the card always searches for itself.
    analysisStore: async () => ({ passing: false, onPassChange: () => () => {}, passRead: () => null }),
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
  widget.pvsEl = {
    dataset: {},
    // `_paintPvs` reads the rendered row count to decide when the dock refits.
    get children() { return (String(this._html ?? "").match(/class="engine-pv(?:\s|")/g) || []); },
    get innerHTML() { return this._html ?? ""; },
    set innerHTML(value) { this._html = String(value); },
  };
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

  it("searches exactly the lines it shows, and paints each depth the engine reaches", async () => {
    // The Coach's engine review is ON: it no longer widens the card's search — it asks
    // the shared store for the alternative line itself, under the move that needs one.
    const { widget } = widgetHarness({ coachOn: true });
    // The card's Line −/+ is the whole contract with the engine: at 1 line it asks
    // Stockfish for MultiPV 1 on every view, Analyze included (a second line nobody
    // renders used to double the nodes of every search). The coach's own reads run
    // through the same store and ask for the width they need themselves — the card
    // never widens a search for it.
    const sent = [];
    let push = null;
    const engine = {
      depth: 16,
      open: vi.fn(async (req) => { sent.push(["open", req.multipv]); return { session_id: "s", fen: req.fen, pvs: [], running: true }; }),
      update: vi.fn(async (req) => { sent.push(["update", req.multipv]); return { session_id: "s", fen: req.fen, pvs: [], running: true }; }),
      watch: vi.fn((fn) => { push = fn; }),
      snapshot: () => null,
    };
    widget.engine = engine;
    widget.engineDepth = 16;
    widget.el = { hidden: true, classList: { add() {}, remove() {}, contains: () => false } };
    widget.lastFen = "current w - - 0 1";
    widget.linesReadout = { textContent: "", title: "" };
    await widget.openForCurrent();
    expect(widget.multipv).toBe(1);
    await widget._setMultipv(3);
    expect(sent).toEqual([["open", 1], ["update", 3]]);
    expect(widget.multipv).toBe(3);
    // The readout counts only what is shown: with the Coach on there is no extra line.
    expect(widget.linesReadout.textContent).toBe("3");
    expect(widget.linesReadout.title).toBe("Lines shown");
    // The subscription is the paint path — no sampler. Each depth the engine reports
    // repaints the rows; the depth readout follows it.
    expect(typeof push).toBe("function");
    widget._renderSnapshot = vi.fn();
    const snap = { session_id: "s", fen: "current w - - 0 1", current_depth: 7, max_depth: 16, pvs: [{ score_cp: 30, pv_uci: ["e2e4"], pv_san: ["e4"] }] };
    // One frame per paint (jsdom-less test: run the frame callback immediately).
    const frame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
    globalThis.cancelAnimationFrame = () => {};
    try {
      push(snap);
    } finally {
      globalThis.requestAnimationFrame = frame;
    }
    expect(widget._renderSnapshot).toHaveBeenCalledWith(snap);
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
    // The navigation rule now lives in its own module (controllers/analyze-selection.js).
    const start = selectionSource.indexOf("async function analysisTreeNav(");
    const code = selectionSource.slice(start, selectionSource.indexOf("\n  async function onAnalysisBoardMove", start));
    // The source epoch: unchanged here, so the step is never fenced out.
    const captureSource = () => ({ isCurrent: () => true });
    const nav = new Function("appState", "ensureAnalyzeView", "selectAnalysisNode", "captureSource",
      `${code}; return analysisTreeNav;`)(appState, async () => ({}), select, captureSource);
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
describe("Analyze keyboard: Home / End and ↑ / ↓", () => {
  it("routes Home and End (and Analyze's ↑ ↓, as on Lichess) to the ends of the line, and to Build's own ends", () => {
    const i = source.indexOf('const end = { Home: "start", End: "end", ...(inBuild ? {} : { ArrowUp: "start", ArrowDown: "end" }) }[event.key];');
    expect(i).toBeGreaterThan(0);
    const block = source.slice(i, i + 420);
    expect(block).toMatch(/if \(stepsBoard && end\)/);
    expect(block).toMatch(/analysisTreeNav\(end\)/);
    expect(block).toMatch(/buildGoRoot\(\)/);
    expect(block).toMatch(/buildGoToEnd\(\)/);
  });

  it("opens the keyboard list on ?", async () => {
    expect(source).toMatch(/if \(event\.key === "\?"\) return void import\("\.\/shortcuts-help\.js"\)/);
    const { shortcutRows } = await import("./shortcuts-help.js");
    expect(shortcutRows("analyze").map(([k]) => k)).toContain("↑ ↓ · Home End");
    expect(shortcutRows("build").map(([k]) => k)).toContain("↑ ↓ · J K");
    expect(shortcutRows("library").map(([k]) => k)).toEqual(["Ctrl K", "?"]);
  });
});
