// The desktop Analyze panel: the coach, the engine's lines, the score sheet,
// then the folds. The move list is always on screen (no tab to find it), the
// game report is one closed row under it, and the game's sources are the two
// folds after that. The tabs are the stacked tablet's and the phone's.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("./index.html");
const css = read("./views/analyze-chart.css");

const view = html.slice(html.indexOf('id="view-analyze"'), html.indexOf('id="view-build"'));
const panes = view.slice(view.indexOf('id="analyze-panes"'), view.indexOf('id="analyze-open"'));
const sources = view.slice(view.indexOf('id="analyze-open"'));

describe("Analyze's desktop panel", () => {
  it("keeps the score sheet on screen without a tab", () => {
    expect(panes).toContain('id="analysis-results"');
    // No tab is needed to see it: the pane is shown whenever a game is on the
    // board, and only the stacked and phone bands gate panes on data-pane.
    expect(css).not.toMatch(/^#view-analyze:not\(\[data-pane="moves"\]\) \.moves-pane/m);
    expect(css).toMatch(/\.an-panes > \.moves-pane:not\(\[hidden\]\) \{ flex: none; \}/);
    // The sheet is one of the column's panes, before the report.
    expect(panes.indexOf('id="analysis-results"')).toBeLessThan(panes.indexOf('id="analysis-report"'));
    // The tab strip is off at a side-by-side width; only the stacked and phone
    // bands turn it on.
    expect(css).toMatch(/\.an-tabs \{[^}]*display: none;/);
    expect(css).toMatch(/@media \(min-width: 761px\) and \(max-width: 860px\)[\s\S]*?\.an-tabs \{ display: flex;/);
  });

  it("keeps the game report a closed fold that stays compact when opened", () => {
    expect(panes).toMatch(/<details class="drawer an-pane report-pane" id="analysis-report"[^>]*>\s*<summary>Game report<\/summary>/);
    expect(panes).not.toMatch(/id="analysis-report"[^>]*\sopen(?=[\s>])/);
    // Opened, it takes under half the screen and scrolls inside itself, so the
    // score sheet keeps its place.
    expect(css).toMatch(/\.an-panes > \.report-pane\[open\] \{[^}]*max-height: min\(45vh, 420px\);[^}]*overflow: auto;/);
    // Every part of the report lives inside the fold, not in a pane of its own.
    for (const id of ["analysis-summary", "analysis-handoff"]) expect(panes).toContain(`id="${id}"`);
  });

  it("keeps the game's sources as the panel's last two folds", () => {
    expect(sources).toMatch(/id="pgn-drawer">\s*<summary>Analyze source · PGN<\/summary>/);
    expect(sources).toMatch(/id="history-drawer"[^>]*>\s*<summary>Recent analyses<\/summary>/);
    // They sit outside the panes, after the report.
    expect(view.indexOf('id="analyze-open"')).toBeGreaterThan(view.indexOf('id="analyze-panes"'));
  });
});
