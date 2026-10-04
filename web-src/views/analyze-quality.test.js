// The run's search coverage stays in the saved report's metadata; the page does not
// print it (a "2 positions below depth 16" line told players nothing they could act on).
import { afterEach, describe, expect, it } from "vitest";

import { createAnalyzeView } from "./analyze.js";

function render(quality) {
  const host = { innerHTML: "", querySelectorAll: () => [] };
  globalThis.document = { getElementById: (id) => (id === "analysis-summary" ? host : null) };
  const appState = { analysis: { quality }, analysisVarNodes: new Map() };
  const view = createAnalyzeView({
    appState,
    escapeHtml: (s) => String(s),
    START_FEN: "",
    showAnalysisPly: () => {},
    selectAnalysisNode: () => {},
    revealAnalysisResults: () => {},
  });
  view.renderClassificationBars([{ side: "white", classification: "best" }]);
  return host.innerHTML;
}

const BASE = {
  search: "full",
  actual_depth_max: 16,
  actual_depth_min: 16,
  actual_depth_avg: 16,
  target_depth: 16,
  shallow_positions: 0,
  terminal_positions: 0,
  maia: { available: false },
  engine: "stockfish (browser)",
};

describe("analysis quality summary", () => {
  afterEach(() => {
    delete globalThis.document;
  });

  it("never prints search coverage under the class bars", () => {
    for (const quality of [
      { ...BASE, completeness: "no-maia" },
      { ...BASE, search: "partial-shallow", shallow_positions: 2, completeness: "partial-shallow,no-maia" },
    ]) {
      const html = render(quality);
      expect(html).toMatch(/class-bars/);
      expect(html).not.toMatch(/quality-note|below depth|partial-shallow|no-maia/);
    }
  });
});
