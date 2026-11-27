// The review bar under the Analyze coach (web-src/views/analyze-review.js):
// which key moment it names, when it offers Retry, and what a try on
// the board reads as.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewBar } from "./analyze-review.js";
import { noteTriedGrade, noteUngraded, triedGrade } from "../analyze-tried-grade.js";
import { asSlices } from "../state/as-slices.fixture.js";

const blunder = {
  ply: 3, side: "white", label: "2.Nf3", grade: "blunder", loss: 31,
  move: { san: "Nf3", classification: "blunder" }, best: { san: "d4", uci: "d2d4" },
};
const great = { ply: 6, side: "black", label: "3…Nc6", grade: "great", loss: null, move: { san: "Nc6", classification: "great" }, best: null };

function makeTree() {
  const root = { id: "root", isMainline: true, ply: 0, parent: null };
  const byId = new Map([["root", root]]);
  let prev = root;
  for (let ply = 1; ply <= 8; ply++) {
    const node = { id: `m${ply}`, ply, isMainline: true, parent: prev, uci: `u${ply}` };
    byId.set(node.id, node);
    prev = node;
  }
  return { byId };
}

function setup() {
  // The markup arrives as a safe-HTML value; the fake keeps its text.
  let markup = "";
  const bar = {
    hidden: true, dataset: {}, addEventListener: vi.fn(),
    get innerHTML() { return markup; }, set innerHTML(value) { markup = String(value); },
    replaceChildren() { markup = ""; },
  };
  globalThis.document = { getElementById: (id) => (id === "coach-review" ? bar : null) };
  const appState = { analysisTree: makeTree(), analysisCurrentNodeId: "root", analysisPly: 0 };
  const calls = { show: [], select: [] };
  const review = createReviewBar({
    ...asSlices(appState), 
    getReport: () => ({ moments: [blunder, great] }),
    showAnalysisPly: async (ply) => calls.show.push(ply),
    selectAnalysisNode: async (id) => { calls.select.push(id); appState.analysisCurrentNodeId = id; },
  });
  const at = (id, ply) => { appState.analysisCurrentNodeId = id; appState.analysisPly = ply; review.paint(); };
  const click = (kind) => bar.addEventListener.mock.calls[0][1]({ target: { closest: () => ({ dataset: { review: kind }, disabled: false }) } });
  return { bar, ...asSlices(appState), appState, calls, review, at, click };
}

afterEach(() => { delete globalThis.document; });

describe("review bar", () => {
  it("is hidden while the report has no key moments", () => {
    const { bar, review } = setup();
    globalThis.document.getElementById("coach-review").hidden = false;
    createReviewBar({ ...asSlices({}), getReport: () => null, showAnalysisPly() {}, selectAnalysisNode() {} }).paint();
    expect(bar.hidden).toBe(true);
    expect(review.step).toBeTypeOf("function");
  });

  it("names the next moment from the start and offers no fix there", () => {
    const { bar, at } = setup();
    at("root", 0);
    expect(bar.hidden).toBe(false);
    expect(bar.innerHTML).toContain("Next: 2.Nf3 Blunder");
    expect(bar.innerHTML).toContain("1/2");
    expect(bar.innerHTML).not.toContain('data-review="retry"');
  });

  it("offers Retry on a mistake with a better move, not on a great move", () => {
    const { bar, at } = setup();
    at("m3", 3);
    expect(bar.innerHTML).toContain("2.Nf3 Blunder");
    expect(bar.innerHTML).toContain('data-review="retry"');
    expect(bar.innerHTML).not.toContain('data-review="best"');
    // DOM (and Tab) order matches visual left-to-right layout: label -> Retry -> prev -> next.
    const idx = (s) => bar.innerHTML.indexOf(s);
    expect(idx('data-review="go"')).toBeLessThan(idx('data-review="retry"'));
    expect(idx('data-review="retry"')).toBeLessThan(idx('data-review="prev"'));
    expect(idx('data-review="prev"')).toBeLessThan(idx('data-review="next"'));
    at("m6", 6);
    expect(bar.innerHTML).toContain("3…Nc6 Great");
    expect(bar.innerHTML).not.toContain('data-review="retry"');
  });

  it("Retry goes back one move and asks for a better one; the engine's move is right, another is wrong", async () => {
    const { bar, appState, calls, at, click } = setup();
    at("m3", 3);
    await click("retry");
    expect(calls.select).toEqual(["m2"]);
    expect(bar.innerHTML).toContain("Find a better move than Nf3");
    expect(bar.innerHTML).not.toContain('data-review="retry"');
    const m2 = appState.analysisTree.byId.get("m2");
    appState.analysisTree.byId.set("v1", { id: "v1", isMainline: false, isVariation: true, parent: m2, uci: "g1h3",
      fenBefore: "fen-at-m2" });
    at("v1", -1);
    expect(bar.innerHTML).toContain("Checking that move");
    expect(bar.innerHTML).not.toContain("Not the best move");
    // The coach grades it worse than the engine's move: the bar repaints on its own.
    noteTriedGrade("fen-at-m2", "g1h3", "mistake");
    expect(bar.innerHTML).toContain("Not the best move");
    expect(bar.innerHTML).toContain('data-review="retry"');
    appState.analysisTree.byId.set("v2", { id: "v2", isMainline: false, isVariation: true, parent: m2, uci: "d2d4" });
    at("v2", -1);
    expect(bar.innerHTML).toContain("d4 is the best move");
  });

  it("a Retry move the engine rates as good as its own counts as found, not as wrong", async () => {
    const { bar, appState, at, click, review } = setup();
    at("m3", 3);
    await click("retry");
    const m2 = appState.analysisTree.byId.get("m2");
    const fenBefore = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    appState.analysisTree.byId.set("v1", { id: "v1", isMainline: false, isVariation: true, parent: m2,
      uci: "c2c4", san: "c4", fenBefore });
    at("v1", -1);
    // The coach's read of c4 lands: as good as the engine's d4.
    noteTriedGrade(fenBefore, "c2c4", "best");
    review.paint();
    expect(bar.innerHTML).not.toContain("Not the best move");
    expect(bar.innerHTML).toContain("is-right");
    expect(bar.innerHTML).toContain("As good as d4");
    expect(bar.innerHTML).not.toContain('data-review="retry"');
  });

  it("a Retry move the coach cannot grade ends on a clear state, not on Checking", async () => {
    const { bar, appState, at, click } = setup();
    at("m3", 3);
    await click("retry");
    const m2 = appState.analysisTree.byId.get("m2");
    appState.analysisTree.byId.set("v1", { id: "v1", isMainline: false, isVariation: true, parent: m2,
      uci: "b1c3", san: "Nc3", fenBefore: "fen-ungraded" });
    at("v1", -1);
    expect(bar.innerHTML).toContain("Checking that move");
    // Grading is off or the engine could not read it: the coach says it will not grade.
    noteUngraded({ prevFen: "fen-ungraded", lastUci: "b1c3" });
    expect(bar.innerHTML).not.toContain("Checking that move");
    expect(bar.innerHTML).toContain("Could not check that move");
    expect(bar.innerHTML).toContain('data-review="retry"');
    // Grading back on: the real grade replaces it.
    noteTriedGrade("fen-ungraded", "b1c3", "best");
    expect(bar.innerHTML).toContain("As good as d4");
  });

  it("a known grade is not overwritten by a later ungraded visit", () => {
    noteTriedGrade("fen-known", "a2a3", "mistake");
    noteUngraded({ prevFen: "fen-known", lastUci: "a2a3" });
    expect(triedGrade("fen-known", "a2a3")).toBe("mistake");
  });

  it("steps from a branch as from the move it replaces", async () => {
    const { appState, calls, review } = setup();
    const m2 = appState.analysisTree.byId.get("m2");
    appState.analysisTree.byId.set("v1", { id: "v1", isMainline: false, isVariation: true, parent: m2, uci: "d2d4" });
    appState.analysisCurrentNodeId = "v1";
    appState.analysisPly = -1;
    review.step("next");
    review.step("prev");
    expect(calls.show).toEqual([6]);
  });

  it("switches Review to Next key after analysis, wraps on the last moment, and restores Review on PGN edit", () => {
    const label = { textContent: "Review" };
    const runListeners = [];
    const pgnListeners = [];
    const runBtn = {
      dataset: {}, title: "",
      querySelector: (s) => (s === ".bl" ? label : null),
      addEventListener: (_t, fn) => runListeners.push(fn),
    };
    const pgnInput = {
      dataset: {},
      addEventListener: (_t, fn) => pgnListeners.push(fn),
    };
    const { bar, calls, at } = setup();
    globalThis.document = {
      getElementById: (id) => (id === "coach-review" ? bar : id === "run-analysis" ? runBtn : id === "pgn-input" ? pgnInput : null),
    };

    at("root", 0);
    expect(runBtn.dataset.action).toBe("next-key");
    expect(label.textContent).toBe("Next key");

    const stop = vi.fn();
    runListeners[0]({ stopImmediatePropagation: stop });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(calls.show).toEqual([3]);

    // On the last moment, label flips to First key and wraps cleanly to moment 0.
    at("m6", 6);
    expect(label.textContent).toBe("First key");
    runListeners[0]({ stopImmediatePropagation: vi.fn() });
    expect(calls.show).toEqual([3, 3]);

    // Editing PGN immediately restores Review mode.
    pgnListeners[0]();
    expect(runBtn.dataset.action).toBeUndefined();
    expect(label.textContent).toBe("Review");
  });
});
