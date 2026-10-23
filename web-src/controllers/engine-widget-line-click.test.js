// A move in an engine line is a move in the move list: clicking one plays the
// line up to that move into the Analyze tree, as variations from the position on
// the board, and ends on that move. Clicking the row plays its first move. The
// engine card never walks a line on its own board any more.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Chess } from "chess.js";

import { html } from "../html.js";
import { clampPly, decodeLine, encodeLine, moveLineHtml, walkLine } from "../move-text.js";
import { createPassFeed } from "./engine-pass-feed.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const widgetSource = readFileSync(new URL("./engine-widget.js", import.meta.url), "utf8");

function stubEl() {
  const listeners = {};
  return {
    hidden: true,
    innerHTML: "",
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { listeners[type] = fn; },
    fire(type, event) { listeners[type]?.(event); },
  };
}

function fenAfter(fen, uci) {
  const chess = new Chess(fen);
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return chess.fen();
}

// The session's contract as the widget sees it: a move is played into the tree
// and the board is left on the position after it (controllers/analyze-selection.js).
function fakeSession(appState, { lands = true } = {}) {
  const calls = [];
  return {
    calls,
    onAnalysisBoardMove: vi.fn(async (uci, fen) => {
      calls.push([uci, fen]);
      if (lands) appState.analysisBoardFen = fenAfter(fen, uci);
    }),
  };
}

function harness({ view = "analyze", boardFen = START, lands = true, withSession = true } = {}) {
  const appState = { analysisBoardFen: boardFen };
  const session = fakeSession(appState, { lands });
  const deps = {
    html, setEngineBestArrow: vi.fn(), localGameOver: () => null, pvSan: () => [],
    activeViewName: () => view, effectiveStockfishDepth: () => 16,
    createSharedEvaluationProvider: vi.fn(), appState, boards: {}, START_FEN: START,
    explorerEvalEngine: { repaint: vi.fn() }, formatEngineEval: () => "0.00",
    getAnalyzeSession: () => (withSession ? session : null),
    paintUnlocks: () => {}, createPassFeed, hooks: {},
    clampPly, decodeLine, encodeLine, moveLineHtml, walkLine,
    analysisStore: async () => ({}),
  };
  const code = widgetSource.slice(widgetSource.indexOf("class EngineWidget {"));
  const Widget = new Function(...Object.keys(deps), `return (${code.trim()});`)(...Object.values(deps));
  const widget = new Widget();
  Object.assign(widget, {
    pvsEl: stubEl(), closeBtn: stubEl(), linesUpBtn: stubEl(), linesDownBtn: stubEl(),
    linesReadout: stubEl(),
  });
  widget._bindControls();
  widget.lastFen = boardFen;
  return { widget, appState, session, deps };
}

const LINE = encodeLine(START, ["e2e4", "e7e5", "g1f3"]);
const rowOf = (mt = LINE) => ({ dataset: { mt, line: "0" } });
const moveAt = (p) => ({ dataset: { p: String(p) } });

// What a click lands on: the row it is in and, when a move was clicked, that move.
function click(widget, { row = null, move = null }) {
  const target = {
    closest: (sel) => (sel.includes("engine-pv") ? row : sel.includes("pv-move") ? move : null),
  };
  widget.pvsEl.fire("click", { target });
}

describe("an engine line clicked into the move list", () => {
  it("plays the line up to the move that was clicked", () => {
    const { widget } = harness();
    const play = vi.spyOn(widget, "_playLine");
    const row = rowOf();
    click(widget, { row, move: moveAt(2) });
    expect(play).toHaveBeenCalledWith(row, 3);
  });

  it("plays its first move when the row itself is clicked", () => {
    const { widget } = harness();
    const play = vi.spyOn(widget, "_playLine");
    const row = rowOf();
    click(widget, { row });
    expect(play).toHaveBeenCalledWith(row, 1);
  });

  it("plays every move in order, each from the position the one before reached", async () => {
    const { widget, appState, session } = harness();
    await widget._playLine(rowOf(), 3);
    expect(session.calls.map(([uci]) => uci)).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(session.calls[0][1]).toBe(START);
    expect(session.calls[1][1]).toBe(fenAfter(START, "e2e4"));
    expect(session.calls[2][1]).toBe(fenAfter(fenAfter(START, "e2e4"), "e7e5"));
    expect(appState.analysisBoardFen).toBe(fenAfter(fenAfter(fenAfter(START, "e2e4"), "e7e5"), "g1f3"));
  });

  it("stops at a move that does not land instead of playing the rest from the wrong position", async () => {
    const { widget, session } = harness({ lands: false });
    await widget._playLine(rowOf(), 3);
    expect(session.calls.map(([uci]) => uci)).toEqual(["e2e4"]);
  });

  it("ignores a line that belongs to a position the board has left", async () => {
    const other = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const { widget, session } = harness({ boardFen: other });
    await widget._playLine(rowOf(), 2);
    expect(session.onAnalysisBoardMove).not.toHaveBeenCalled();
  });

  it("does nothing on a view without the analysis tree", async () => {
    const { widget, session } = harness({ view: "build" });
    await widget._playLine(rowOf(), 2);
    expect(session.onAnalysisBoardMove).not.toHaveBeenCalled();
  });

  it("does nothing before the Analyze session exists", () => {
    const { widget } = harness({ withSession: false });
    expect(widget._playLine(rowOf(), 2)).toBe(undefined);
  });

  it("does not play an empty line or a row with no moves yet", async () => {
    const { widget, session } = harness();
    await widget._playLine(rowOf(`${START}|`), 1);
    await widget._playLine({ dataset: { line: "0" } }, 1);
    expect(session.onAnalysisBoardMove).not.toHaveBeenCalled();
  });
});
