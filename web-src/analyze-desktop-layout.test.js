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
    // The sheet has its own heading, so it never reads as the engine's lines.
    expect(panes).toMatch(/id="analysis-results"[^>]*>\s*<header class="an-pane-head"><b>Moves<\/b><\/header>/);
    // No tab is needed to see it: the pane is shown whenever a game is on the
    // board, and only the stacked and phone bands gate panes on data-pane.
    expect(css).not.toMatch(/^#view-analyze:not\(\[data-pane="moves"\]\) \.moves-pane/m);
    expect(css).toMatch(/\.an-panes > \.moves-pane:not\(\[hidden\]\) \{ flex: none; \}/);
    // The sheet is one of the column's panes, before the report.
    expect(panes.indexOf('id="analysis-results"')).toBeLessThan(panes.indexOf('id="analysis-report"'));
    // The tab strip is off at a side-by-side width; only the stacked and phone
    // bands turn it on.
    expect(css).toMatch(/\.an-tabs \{[^}]*display: none;/);
    // The chosen tab is the shared accent line on the strip's rule, not a plate.
    expect(css).toMatch(/\.an-tab\[aria-selected="true"\]::after \{ opacity: 1; \}/);
    expect(css).not.toMatch(/\.an-tab\[aria-selected="true"\] \{ background: var\(--panel\)/);
    expect(css).toMatch(/@media \(min-width: 761px\) and \(max-width: 860px\)[\s\S]*?\.an-tabs \{ display: flex;/);
  });

  it("keeps the game report a closed fold that stays compact when opened", () => {
    expect(panes).toMatch(/<details class="drawer an-pane report-pane" id="analysis-report"[^>]*>[\s\S]*?<summary>Game report<\/summary>/);
    expect(panes).not.toMatch(/id="analysis-report"[^>]*\sopen(?=[\s>])/);
    // Opened, it takes under half the screen and scrolls inside itself, so the
    // score sheet keeps its place.
    expect(css).toMatch(/\.an-panes > \.report-pane\[open\] \{[^}]*max-height: min\(45vh, 420px\);[^}]*overflow: auto;/);
    // Smart review slot reserved above report content (future lane).
    expect(panes).toContain('class="review-slot"');
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

describe("Analyze title", () => {
  it("names the loaded game in the page's h1, under the board", () => {
    // The caption is the screen's title (inspector: every screen has one h1);
    // it stays empty until a game is loaded, so no standing label is drawn.
    expect(html).toMatch(/<h1 class="board-label board-caption" id="analysis-board-caption"/);
  });
});

describe("Analyze evaluation placement", () => {
  it("puts the evaluation under the board only on the stacked and phone bands", async () => {
    // At a wide desktop the evaluation is the panel's second block, beside the
    // board, so the first screen reads coach, evaluation, engine. Only a stacked
    // tablet and a phone move it under the board.
    const { LAYOUT_QUERIES } = await import("./views/analyze-panes.js");
    expect(Object.keys(LAYOUT_QUERIES)).toEqual(["phone", "stacked"]);
  });
});

describe("Analyze desktop geometry", () => {
  const styles = read("./styles.css");

  it("does not stretch the board column past the board on desktop", () => {
    // The board is a square capped by its width share, so a stretched column
    // left a tall empty area under it (175px at 1180x900) while the panel
    // stayed full height.
    const desktop = styles.match(/@media \(min-width: 960px\) \{[\s\S]*?\n\}/);
    expect(desktop).toBeTruthy();
    expect(desktop[0]).toMatch(/\.study \.board-area \{[^}]*align-self: start;/);
  });
});

describe("Analyze engine pane", () => {
  it("draws one line stepper, the pane's, not the floating window's copy", () => {
    // The docked window carries its own line stepper; the pane's stepper beside
    // the head is the only one shown in the Analyze slot.
    expect(css).toMatch(/#analysis-engine-slot \.engine-lines \{ display: none; \}/);
    expect(html).toContain('id="analyze-lines-readout"');
    // The pane's stepper is bare, not a pill that stretches across the head.
    expect(css).toMatch(/\.engine-pane > \.an-pane-head \.engine-lines \{ justify-self: start;[^}]*background: none;/);
  });
});
