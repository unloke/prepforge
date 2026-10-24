// The review bar under the Analyze coach (web-src/views/analyze-review.js):
// which key moment it names, when it offers Best and Retry, and what a try on
// the board reads as.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewBar } from "./analyze-review.js";

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
  const calls = { show: [], select: [], play: [] };
  const review = createReviewBar({
    appState,
    getReport: () => ({ moments: [blunder, great] }),
    showAnalysisPly: async (ply) => calls.show.push(ply),
    selectAnalysisNode: async (id) => { calls.select.push(id); appState.analysisCurrentNodeId = id; },
    playMoveAt: async (id, uci) => calls.play.push([id, uci]),
  });
  const at = (id, ply) => { appState.analysisCurrentNodeId = id; appState.analysisPly = ply; review.paint(); };
  const click = (kind) => bar.addEventListener.mock.calls[0][1]({ target: { closest: () => ({ dataset: { review: kind }, disabled: false }) } });
  return { bar, appState, calls, review, at, click };
}

afterEach(() => { delete globalThis.document; });

describe("review bar", () => {
  it("is hidden while the report has no key moments", () => {
    const { bar, review } = setup();
    globalThis.document.getElementById("coach-review").hidden = false;
    createReviewBar({ appState: {}, getReport: () => null, showAnalysisPly() {}, selectAnalysisNode() {}, playMoveAt() {} }).paint();
    expect(bar.hidden).toBe(true);
    expect(review.step).toBeTypeOf("function");
  });

  it("names the next moment from the start and offers no fix there", () => {
    const { bar, at } = setup();
    at("root", 0);
    expect(bar.hidden).toBe(false);
    expect(bar.innerHTML).toContain("Next: 2.Nf3 Blunder");
    expect(bar.innerHTML).toContain("1/2");
    expect(bar.innerHTML).not.toContain('data-review="best"');
  });

  it("offers Best and Retry on a mistake with a better move, not on a great move", () => {
    const { bar, at } = setup();
    at("m3", 3);
    expect(bar.innerHTML).toContain("2.Nf3 Blunder");
    expect(bar.innerHTML).toContain('data-review="best"');
    expect(bar.innerHTML).toContain('data-review="retry"');
    at("m6", 6);
    expect(bar.innerHTML).toContain("3…Nc6 Great");
    expect(bar.innerHTML).not.toContain('data-review="best"');
  });

  it("Best plays the engine's move from the position before the moment", async () => {
    const { bar, calls, at, click } = setup();
    at("m3", 3);
    bar.dataset.ply = "3";
    await click("best");
    expect(calls.play).toEqual([["m2", "d2d4"]]);
  });

  it("Retry goes back one move and asks for a better one; the engine's move is right, another is wrong", async () => {
    const { bar, appState, calls, at, click } = setup();
    at("m3", 3);
    await click("retry");
    expect(calls.select).toEqual(["m2"]);
    expect(bar.innerHTML).toContain("Find a better move than Nf3");
    expect(bar.innerHTML).not.toContain('data-review="retry"');
    const m2 = appState.analysisTree.byId.get("m2");
    appState.analysisTree.byId.set("v1", { id: "v1", isMainline: false, isVariation: true, parent: m2, uci: "g1h3" });
    at("v1", -1);
    expect(bar.innerHTML).toContain("Not the best move");
    appState.analysisTree.byId.set("v2", { id: "v2", isMainline: false, isVariation: true, parent: m2, uci: "d2d4" });
    at("v2", -1);
    expect(bar.innerHTML).toContain("d4 is the best move");
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
});
