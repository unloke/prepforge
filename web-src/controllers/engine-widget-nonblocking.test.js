import { html } from "../html.js";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { engineConsentHtml } from "./engine-consent.js";

// The full net's 94 MB question is a row above the lines, never a replacement for
// them: while it waits for an answer the lite search keeps running, and answering
// it (either way) never stops or restarts that search.
const widgetSource = readFileSync(new URL("./engine-widget.js", import.meta.url), "utf8");

function stubEl() {
  const listeners = {};
  return {
    hidden: true,
    innerHTML: "",
    textContent: "",
    dataset: {},
    title: "",
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { listeners[type] = fn; },
    fire(type, event) { listeners[type]?.(event); },
  };
}

function harness({ choice = "ask" } = {}) {
  let choiceNow = choice;
  const subscribers = new Set();
  const deps = {
    html,
    setEngineBestArrow: vi.fn(), localGameOver: () => null,
    activeViewName: () => "analyze", effectiveStockfishDepth: () => 16,
    createSharedEvaluationProvider: vi.fn(), appState: {}, boards: {}, START_FEN: "start",
    explorerEvalEngine: { repaint: vi.fn() }, formatEngineEval: () => "0.00",
    getAnalyzeSession: () => null,
    fullEngineChoice: () => choiceNow,
    chooseFullEngine: vi.fn(async (full) => { choiceNow = full ? null : "download"; }),
    subscribeEngineSetup: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    subscribeEngineProfile: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    engineConsentHtml,
  };
  const code = widgetSource.slice(widgetSource.indexOf("class EngineWidget {"));
  const Widget = new Function(...Object.keys(deps), `return (${code.trim()});`)(...Object.values(deps));
  const widget = new Widget();
  const row = stubEl();
  Object.assign(widget, {
    consentEl: row, pvsEl: stubEl(), el: stubEl(),
    depthReadout: stubEl(), evalHead: stubEl(), evalBarText: stubEl(),
    linesReadout: stubEl(), linesUpBtn: stubEl(), linesDownBtn: stubEl(), closeBtn: stubEl(),
  });
  widget._bindControls();
  const sent = [];
  widget.engine = {
    open: vi.fn(async (req) => { sent.push(["open", req.fen]); return { session_id: "s", fen: req.fen, pvs: [], running: true }; }),
    update: vi.fn(async (req) => { sent.push(["update", req.fen]); return { session_id: "s", fen: req.fen, pvs: [], running: true }; }),
    watch: vi.fn(), close: vi.fn(async () => { sent.push(["close"]); }),
  };
  widget.engineDepth = 16;
  widget.currentFen = () => "board w - - 0 1";
  // The device's setup/answer changed elsewhere (a probe finished, Settings answered).
  const emit = (next) => { if (next !== undefined) choiceNow = next; for (const fn of [...subscribers]) fn({ phase: "ready" }); };
  return { widget, row, sent, emit };
}

describe("the full-net question never blocks the engine card", () => {
  it("opens, asks, and searches underneath the question", async () => {
    const { widget, row, sent } = harness();
    await widget.openForCurrent();
    // The question is its own row above the lines...
    expect(row.hidden).toBe(false);
    expect(String(row.innerHTML)).toContain("Download the full engine?");
    // ...and the lite search still started: the card never blanks out for it.
    expect(sent).toEqual([["open", "board w - - 0 1"]]);
    expect(widget.engine.close).not.toHaveBeenCalled();
  });

  it("paints the search's lines while the question is still waiting", () => {
    const { widget, row } = harness();
    widget.lastFen = "board w - - 0 1";
    widget._paintChoice();
    expect(row.hidden).toBe(false);
    // A depth from the running lite search lands on the card as usual.
    widget._renderSnapshot({
      session_id: "s", fen: "board w - - 0 1", running: true, current_depth: 12, max_depth: 16,
      side_to_move: "white", pvs: [{ score_cp: 31, mate_in: null, pv_uci: ["e2e4"], pv_san: ["e4"] }],
    });
    expect(String(widget.pvsEl.innerHTML)).toContain("e4");
    expect(widget.pvsEl.innerHTML).not.toContain("Calculating…");
    // The question is still there, above the line it never replaced.
    expect(row.hidden).toBe(false);
    expect(String(row.innerHTML)).toContain("Keep lite");
    expect(widget.depthReadout.textContent).toBe("12 / 16");
  });

  it("keeps the running search when the answer arrives", async () => {
    const { widget, row, sent } = harness();
    await widget.openForCurrent();
    sent.length = 0;
    // "Keep lite": the row goes and nothing is closed or restarted.
    row.fire("click", { target: { closest: () => ({ dataset: { choice: "no" } }) } });
    await vi.waitFor(() => expect(row.hidden).toBe(true));
    expect(row.innerHTML).toBe("");
    expect(sent).toEqual([]);
    expect(widget.engine.close).not.toHaveBeenCalled();
  });

  it("shows the question when the probe finishes after the card opened", async () => {
    // A first visit: the panel opens before Detect has measured the net, so the
    // question appears later, while the search is already painting lines.
    const { widget, row, sent, emit } = harness({ choice: null });
    await widget.openForCurrent();
    expect(row.hidden).toBe(true);
    expect(sent).toEqual([["open", "board w - - 0 1"]]);
    emit("ask");
    expect(row.hidden).toBe(false);
    expect(String(row.innerHTML)).toContain("Keep lite");
    // The search that was running is untouched by the question appearing.
    expect(sent).toEqual([["open", "board w - - 0 1"]]);
    expect(widget.engine.close).not.toHaveBeenCalled();
  });
});
