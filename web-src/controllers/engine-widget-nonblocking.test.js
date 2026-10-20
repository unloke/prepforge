import { html } from "../html.js";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { engineConsentHtml } from "./engine-consent.js";
import { createPassFeed } from "./engine-pass-feed.js";

// The full net's 94 MB question is a row above the lines, never a replacement for
// them: while it waits for an answer the lite search keeps running, and answering
// it (either way) never stops or restarts that search.
const widgetSource = readFileSync(new URL("./engine-widget.js", import.meta.url), "utf8");

function stubEl() {
  const listeners = {};
  const classes = new Set();
  return {
    hidden: true,
    innerHTML: "",
    textContent: "",
    dataset: {},
    title: "",
    disabled: false,
    classList: {
      add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
      toggle() {}, contains(c) { return classes.has(c); },
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    fire(type, event) { listeners[type]?.(event); },
  };
}

// The card's view of the position store. No pass unless a test starts one; a
// test can publish what the pass has saved and start/end one.
function fakeStore() {
  const listeners = new Set();
  let passing = 0;
  const saved = new Map();
  return {
    saved,
    startPass() { passing += 1; for (const fn of [...listeners]) fn(); },
    endPass() { passing -= 1; for (const fn of [...listeners]) fn(); },
    get passing() { return passing > 0; },
    onPassChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    passRead(fen) {
      const read = saved.get(fen);
      return read ? { session_id: "game-analysis", source: "analysis", fen, running: false, complete: false, ...read } : null;
    },
  };
}

function noPassStore() {
  return fakeStore();
}

function harness({ choice = "ask", store = noPassStore() } = {}) {
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
    engineConsentHtml, createPassFeed,
    analysisStore: async () => store,
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
  return { widget, row, sent, emit, store };
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

// The whole-game pass holds every worker. The card never competes with it: it
// shows what the pass has saved for the position on the board, and says the pass
// is still running when it has not reached that position yet.
describe("a running whole-game pass owns the engine card's numbers", () => {
  it("shows the pass's saved eval and depth, and starts no search", async () => {
    const store = fakeStore();
    const { widget, sent } = harness({ store });
    await widget.openForCurrent();
    await vi.waitFor(() => expect(widget.passFeed).toBeTruthy());
    sent.length = 0;
    store.saved.set("next p - - 0 1", {
      current_depth: 20, max_depth: 20, side_to_move: "white",
      pvs: [{ score_cp: 42, mate_in: null, pv_uci: ["e2e4"], pv_san: ["e4"] }],
    });
    widget.currentFen = () => "next p - - 0 1";
    store.startPass();
    await widget.onBoardChanged();
    // The saved line and its depth, marked as the analysis's own...
    expect(String(widget.pvsEl.innerHTML)).toContain("e4");
    expect(widget.pvsEl.classList.contains("is-analysis-read")).toBe(true);
    expect(widget.depthReadout.textContent).toBe("20 / 20");
    // ...and no search was asked for: the pass has the workers.
    expect(sent).toEqual([]);
  });

  it("says Analyze is still running for a position the pass has not reached, and starts no search", async () => {
    const store = fakeStore();
    const { widget, sent } = harness({ store });
    await widget.openForCurrent();
    await vi.waitFor(() => expect(widget.passFeed).toBeTruthy());
    sent.length = 0;
    widget.currentFen = () => "unreached p - - 0 1";
    store.startPass();
    await widget.onBoardChanged();
    expect(String(widget.pvsEl.innerHTML)).toContain("Analyze is still running");
    expect(String(widget.pvsEl.innerHTML)).not.toContain("Calculating…");
    // No depth, no eval: there is no number for this position yet.
    expect(widget.depthReadout.hidden).toBe(true);
    expect(widget.depthReadout.textContent).toBe("");
    expect(widget.evalHead.dataset.pending).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("searches for itself again when the pass ends, and the status line is gone", async () => {
    const store = fakeStore();
    const { widget, sent } = harness({ store });
    await widget.openForCurrent();
    await vi.waitFor(() => expect(widget.passFeed).toBeTruthy());
    widget.currentFen = () => "unreached p - - 0 1";
    store.startPass();
    await widget.onBoardChanged();
    expect(String(widget.pvsEl.innerHTML)).toContain("Analyze is still running");
    sent.length = 0;
    store.endPass();
    await vi.waitFor(() => expect(String(widget.pvsEl.innerHTML)).not.toContain("Analyze is still running"));
    await vi.waitFor(() => expect(sent).toEqual([["open", "unreached p - - 0 1"]]));
  });
});
