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

function setup(moments = [blunder, great]) {
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
    getReport: () => ({ moments }),
    showAnalysisPly: async (ply) => calls.show.push(ply),
    selectAnalysisNode: async (id) => { calls.select.push(id); appState.analysisCurrentNodeId = id; },
  });
  const at = (id, ply) => { appState.analysisCurrentNodeId = id; appState.analysisPly = ply; review.paint(); };
  const click = (kind) => bar.addEventListener.mock.calls[0][1]({
    target: { closest: () => ({ dataset: { review: kind }, disabled: false, getAttribute: () => null }) },
  });
  return { bar, ...asSlices(appState), appState, calls, review, at, click };
}

function retryVisible(markup) {
  const tag = markup.match(/<button[^>]*data-review="retry"[^>]*>/)?.[0] || "";
  return Boolean(tag) && !tag.includes(" hidden");
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
    expect(bar.innerHTML).toContain('class="cr-control cr-preview g-blunder"');
    expect(bar.innerHTML).toContain('aria-label="Next key move: 2.Nf3, Blunder"');
    expect(bar.innerHTML).toContain('<span class="cr-notation">2.Nf3</span><span class="cr-grade" aria-hidden="true">??</span>');
    expect(bar.innerHTML).not.toContain("Next:");
    expect(retryVisible(bar.innerHTML)).toBe(false);
  });

  it("offers Retry on a mistake with a better move, while the preview names the next key move", () => {
    const { bar, at } = setup();
    at("m3", 3);
    expect(bar.innerHTML).toContain('<span class="cr-notation">3…Nc6</span><span class="cr-grade" aria-hidden="true">!</span>');
    expect(bar.innerHTML).toContain('aria-label="Next key move: 3…Nc6, Great"');
    expect(bar.innerHTML).toContain('aria-label="Previous key move"');
    expect(bar.innerHTML).toContain('aria-label="Retry 2.Nf3"');
    expect(retryVisible(bar.innerHTML)).toBe(true);
    // DOM (and Tab) order matches visual left-to-right layout: previous -> preview -> Retry.
    const idx = (s) => bar.innerHTML.indexOf(s);
    expect(idx('data-review="prev"')).toBeLessThan(idx('data-review="next"'));
    expect(idx('data-review="next"')).toBeLessThan(idx('data-review="retry"'));
    at("m6", 6);
    expect(bar.innerHTML).toContain('<span class="cr-notation">2.Nf3</span><span class="cr-grade" aria-hidden="true">??</span>');
    expect(bar.innerHTML).toContain('aria-label="First key move: 2.Nf3, Blunder"');
    expect(bar.innerHTML).toContain('aria-label="Previous key move: 2.Nf3, Blunder"');
    expect(retryVisible(bar.innerHTML)).toBe(false);
  });

  it("Retry goes back one move and asks for a better one; the engine's move is right, another is wrong", async () => {
    const { bar, appState, calls, at, click } = setup();
    at("m3", 3);
    await click("retry");
    expect(calls.select).toEqual(["m2"]);
    expect(bar.innerHTML).toContain('<span class="cr-notation">Try a move</span>');
    expect(bar.innerHTML).toContain('aria-label="Find a better move than Nf3. Return to 2.Nf3, Blunder"');
    expect(retryVisible(bar.innerHTML)).toBe(false);
    const m2 = appState.analysisTree.byId.get("m2");
    appState.analysisTree.byId.set("v1", { id: "v1", isMainline: false, isVariation: true, parent: m2, uci: "g1h3",
      fenBefore: "fen-at-m2" });
    at("v1", -1);
    expect(bar.innerHTML).toContain('<span class="cr-notation">Checking…</span>');
    expect(bar.innerHTML).toContain('aria-label="Checking that move…. Return to 2.Nf3, Blunder"');
    expect(bar.innerHTML).not.toContain("Not the best move");
    // The coach grades it worse than the engine's move: the bar repaints on its own.
    noteTriedGrade("fen-at-m2", "g1h3", "mistake");
    expect(bar.innerHTML).toContain('<span class="cr-notation">Try again</span>');
    expect(bar.innerHTML).toContain('aria-label="Not the best move. Return to 2.Nf3, Blunder"');
    expect(retryVisible(bar.innerHTML)).toBe(true);
    appState.analysisTree.byId.set("v2", { id: "v2", isMainline: false, isVariation: true, parent: m2, uci: "d2d4" });
    at("v2", -1);
    expect(bar.innerHTML).toContain('<span class="cr-notation">Found</span>');
    expect(bar.innerHTML).toContain('aria-label="d4 is the best move. Return to 2.Nf3, Blunder"');
    expect(retryVisible(bar.innerHTML)).toBe(false);
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
    expect(bar.innerHTML).toContain('<span class="cr-notation">Found</span>');
    expect(bar.innerHTML).toContain('aria-label="As good as d4. Return to 2.Nf3, Blunder"');
    expect(retryVisible(bar.innerHTML)).toBe(false);
  });

  it("a Retry move the coach cannot grade ends on a clear state, not on Checking", async () => {
    const { bar, appState, at, click } = setup();
    at("m3", 3);
    await click("retry");
    const m2 = appState.analysisTree.byId.get("m2");
    appState.analysisTree.byId.set("v1", { id: "v1", isMainline: false, isVariation: true, parent: m2,
      uci: "b1c3", san: "Nc3", fenBefore: "fen-ungraded" });
    at("v1", -1);
    expect(bar.innerHTML).toContain('<span class="cr-notation">Checking…</span>');
    // Grading is off or the engine could not read it: the coach says it will not grade.
    noteUngraded({ prevFen: "fen-ungraded", lastUci: "b1c3" });
    expect(bar.innerHTML).not.toContain('<span class="cr-notation">Checking…</span>');
    expect(bar.innerHTML).toContain('<span class="cr-notation">Not graded</span>');
    expect(bar.innerHTML).toContain('aria-label="Could not check that move. Return to 2.Nf3, Blunder"');
    expect(retryVisible(bar.innerHTML)).toBe(true);
    // Grading back on: the real grade replaces it.
    noteTriedGrade("fen-ungraded", "b1c3", "best");
    expect(bar.innerHTML).toContain('<span class="cr-notation">Found</span>');
    expect(bar.innerHTML).toContain('aria-label="As good as d4. Return to 2.Nf3, Blunder"');
  });

  it("a known grade is not overwritten by a later ungraded visit", () => {
    noteTriedGrade("fen-known", "a2a3", "mistake");
    noteUngraded({ prevFen: "fen-known", lastUci: "a2a3" });
    expect(triedGrade("fen-known", "a2a3")).toBe("mistake");
  });

  it("the key-move navigator can wrap without the separate First key CTA", async () => {
    const { at, click, calls } = setup();
    at("m6", 6);
    await click("next");
    expect(calls.show).toEqual([3]);
  });

  it("a single key move can be reached before and after it without wrapping to itself", async () => {
    const { bar, at, click, calls, review } = setup([blunder]);
    at("root", 0);
    await click("next");
    expect(calls.show).toEqual([3]);
    at("m3", 3);
    expect(bar.innerHTML).toMatch(/data-review="prev"[^>]*disabled/);
    expect(bar.innerHTML).toMatch(/class="cr-control cr-preview g-blunder"[^>]*aria-disabled="true"/);
    review.step("next");
    at("m6", 6);
    expect(bar.innerHTML).toContain('aria-label="Back to key move: 2.Nf3, Blunder"');
    await click("go");
    await click("prev");
    expect(calls.show).toEqual([3, 3, 3]);
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
