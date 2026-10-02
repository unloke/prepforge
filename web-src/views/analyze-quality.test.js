// UX walkthrough 2026-09-30 P3-9: the quality line leaked the server's completeness
// code. Only human copy may reach the page, and only for a partial search.
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

describe("analysis quality summary copy", () => {
  afterEach(() => {
    delete globalThis.document;
  });

  it("says nothing when every position reached the target depth", () => {
    const html = render({ ...BASE, completeness: "no-maia" });
    expect(html).not.toMatch(/quality-note|Analysis quality|no-maia/);
  });

  it("flags a partial search in one line, with human copy only", () => {
    const html = render({ ...BASE, search: "partial-shallow", shallow_positions: 3, completeness: "partial-shallow,no-maia" });
    expect(html).toMatch(/△ 3 positions below depth 16/);
    expect(html).not.toMatch(/partial-shallow|no-maia/);
    expect(html).toMatch(/some positions searched below the target depth; no human-move model/);
  });
});
