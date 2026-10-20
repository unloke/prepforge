// The Analyze panel head's own line (web-src/views/analyze.js). The head names
// the game app.js knows about; for a line played on an empty board there are no
// players, so the view says what the board holds instead of leaving the strip
// with only two buttons in it.
import { afterEach, describe, expect, it } from "vitest";

import { createAnalyzeView } from "./analyze.js";

function el(extra = {}) {
  return {
    textContent: "",
    innerHTML: "",
    dataset: {},
    classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    ...extra,
  };
}

function setup() {
  const ids = {
    "analysis-moves": el(),
    "analysis-results": el({ hidden: true }),
    "analysis-head-status": el(),
  };
  globalThis.document = {
    getElementById: (id) => ids[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const appState = { analysis: null, analysisVarNodes: new Map(), analysisCurrentNodeId: "root" };
  const view = createAnalyzeView({
    appState,
    START_FEN: "8/8/8/8/8/8/8/8 w - - 0 1",
    showAnalysisPly: () => {},
    selectAnalysisNode: async () => {},
    revealAnalysisResults: () => {},
  });
  return { view, appState, status: ids["analysis-head-status"] };
}

afterEach(() => {
  delete globalThis.document;
});

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("Analyze panel head", () => {
  it("says nothing of its own while the panel is empty", () => {
    const { view, status } = setup();
    view.renderAnalysisTree([]);
    expect(status.textContent).toBe("");
  });

  it("names a hand-played line when there are no players to name", () => {
    const { view, appState, status } = setup();
    // One move played from the start position, recorded as a study variation.
    appState.analysisVarNodes.set("v1", {
      id: "v1", seq: 1, parentId: "root", uci: "e2e4", san: "e4",
      fenBefore: FEN, fenAfter: FEN, moveNumber: 1, side: "white",
    });
    view.renderAnalysisTree([]);
    expect(status.textContent).toBe("Your line · 1 half-move");
  });

  it("counts a loaded game's moves, mainline and variations together", () => {
    const { view, appState, status } = setup();
    appState.analysis = {
      moves: [
        { ply: 1, san: "e4", uci: "e2e4", fen_before: FEN, fen_after: FEN, move_number: 1, side: "white" },
        { ply: 2, san: "e5", uci: "e7e5", fen_before: FEN, fen_after: FEN, move_number: 1, side: "black" },
      ],
    };
    view.renderAnalysisTree();
    expect(status.textContent).toBe("This line · 2 half-moves");
  });
});
