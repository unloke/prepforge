// UX walkthrough 2026-09-30 P3-9: the quality line read
//   "Analysis quality: Stockfish depth 16 · no Maia — no-maia"
// leaking the server's completeness code. Only human copy may reach the page.
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

  it("never shows the raw completeness code", () => {
    const html = render({ ...BASE, completeness: "no-maia" });
    expect(html).toMatch(/Analysis quality: Stockfish depth 16 · no Maia<\/summary>/);
    expect(html).not.toMatch(/no-maia/);
    expect(html).toMatch(/no human-move model \(Maia\)/);
  });

  it("translates every listed issue", () => {
    const html = render({ ...BASE, search: "partial-shallow", shallow_positions: 3, completeness: "partial-shallow,no-maia" });
    expect(html).not.toMatch(/partial-shallow|no-maia/);
    expect(html).toMatch(/some positions searched below the target depth; no human-move model/);
  });
});
