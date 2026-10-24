// The run's search coverage stays in the saved report's metadata; the page does not
// print it (a "2 positions below depth 16" line told players nothing they could act on).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { createAnalyzeView } from "./analyze.js";

function render(quality) {
  const host = { dataset: { open: "true" }, get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); }, querySelectorAll: () => [] };
  globalThis.document = { getElementById: (id) => (id === "analysis-summary" ? host : null) };
  const appState = { analysis: { quality }, analysisVarNodes: new Map() };
  const view = createAnalyzeView({
    appState,
    START_FEN: "",
    showAnalysisPly: () => {},
    selectAnalysisNode: () => {},
    revealAnalysisResults: () => {},
  });
  view.renderReport([{ side: "white", classification: "best" }]);
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

  it("never prints search coverage in the report", () => {
    for (const quality of [
      { ...BASE, completeness: "no-maia" },
      { ...BASE, search: "partial-shallow", shallow_positions: 2, completeness: "partial-shallow,no-maia" },
    ]) {
      const html = render(quality);
      expect(String(html)).toMatch(/rp-counts/);
      expect(String(html)).not.toMatch(/quality-note|below depth|partial-shallow|no-maia/);
    }
  });
});

// The Coach head's Engine-review switch. On phones the head floats beside the
// coach text, so the switch is a 22px control in a touch context: it must be a
// 44px target (measured live at 390x660: 38x22 before, 44x44 after), named by
// its label, which a phone shows beside it (the head drops "Coach" there, so a
// bare switch read as nothing).
describe("coach engine-review switch", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("./analyze-chart.css", import.meta.url), "utf8");

  it("is labelled and titled in place, with no standing description", () => {
    const tag = html.match(/<button[^>]*id="explain-engine-toggle"[^>]*>/)[0];
    expect(html).toContain('<label class="cc-switch-label" id="explain-engine-label" for="explain-engine-toggle">Grade moves</label>');
    expect(tag).toContain('aria-labelledby="explain-engine-label"');
    // Not a second "Engine" control: the eval card's Engine button is the live lines.
    expect(tag).not.toMatch(/aria-label="[^"]*Engine/);
    expect(tag).toContain("title=");
    expect(html).not.toMatch(/class="pf-row-text explain-review"/);
    expect(html).not.toContain("read for what they mean to you");
  });

  it("is a 44px touch target in the phone coach head", () => {
    // The switch keeps the shared 34x20 track at every width; the shared tap
    // area is what reaches a thumb, so Analyze no longer redraws it.
    const shared = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const hit = shared.match(/\.pf-switch::after \{[^}]*\}/)[0];
    const inset = Number(/inset:\s*-(\d+)px/.exec(hit)[1]);
    const track = Number(/--switch-h:\s*(\d+)px/.exec(shared)[1]);
    expect(track + 2 * inset).toBeGreaterThanOrEqual(44);
    expect(css).not.toMatch(/#analysis-explain \.cc-head \.pf-switch::before/);
  });
});
