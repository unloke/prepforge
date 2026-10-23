// The Coach's own line (web-src/index.html, views/analyze-chart.css): the two
// ways to get a game sit at its right end, and the line is one row at every
// width. An earlier lane put them here and took them out again because a
// two-word phase chip wrapped the row at 982px and pushed the evaluation card
// down 10px; the fix is the row's, not the chip's, so these pin both.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "views", "analyze-chart.css"), "utf8");
const phoneCss = readFileSync(join(root, "phone.css"), "utf8");

const analyze = html.slice(html.indexOf('id="view-analyze"'), html.indexOf('id="view-build"'));
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`))?.[1] || "";
};

describe("the Coach line", () => {
  it("closes with Last game and Analyze, right of the coach's title", () => {
    const head = analyze.slice(analyze.indexOf('class="cc-head"'), analyze.indexOf('class="coach-prose"'));
    expect(head).toContain("<b>Coach</b>");
    // The line reads left to right: the name, the phase, the review switch, then
    // the two ways to get a game. The actions are the row's last child, so they
    // end it — the owner's screenshot's two red arrows.
    const order = ["<b>Coach</b>", 'id="coach-phase"', 'id="explain-engine-toggle"', 'id="analyze-actions"']
      .map((marker) => head.indexOf(marker));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const id of ["analyze-actions", "fetch-my-game", "run-analysis"]) {
      expect(head).toContain(`id="${id}"`);
    }
    // The head strip above the verdict is gone: it named the game (now the bar
    // under the board does) and, with no game, stood on a sentence explaining
    // the empty panel.
    expect(analyze).not.toContain('class="panel-head"');
    expect(analyze).not.toContain('id="analysis-game-meta"');
    expect(analyze).not.toContain('id="analysis-head-status"');
    expect(analyze).not.toContain('class="ahi-hint"');
  });

  it("is one row: the phase chip yields its width, the row never wraps", () => {
    // The row is taller than the old strip (26px actions vs a 22px switch) and
    // the card's floor is written from that number, so a wrapped row would be
    // 4px of movement in the instrument below it.
    expect(rule(".cc-head")).toMatch(/flex-wrap: nowrap/);
    expect(rule(".phase-chip")).toMatch(/flex: 0 1 auto/);
    expect(rule(".phase-chip")).toMatch(/text-overflow: ellipsis/);
    expect(rule(".phase-chip")).toMatch(/white-space: nowrap/);
    expect(rule("#analyze-actions")).toMatch(/flex-wrap: nowrap/);
    expect(rule(".coach-card")).toMatch(/--coach-head: 26px/);
    expect(rule(".coach-card")).toMatch(/grid-template-rows: var\(--coach-head\) minmax\(0, 1fr\) var\(--coach-foot\) auto/);
  });

  it("keeps both actions readable as words", () => {
    // Two glyphs would add 20px to a row with none to give; the words are the
    // labels, and Last game is also a row in the phone's Games sheet.
    expect(rule("#analyze-actions .btn > .bi")).toMatch(/display: none/);
    expect(analyze).toMatch(/id="fetch-my-game"[^>]*>.*?<span class="bl">Last game<\/span>/);
    expect(analyze).toMatch(/id="run-analysis"[^>]*>.*?<span class="bl">Analyze<\/span>/);
    expect(phoneCss).toMatch(/#fetch-my-game \{ display: none; \}/);
  });

  it("reads the game's name in the full ink", () => {
    expect(rule("#view-analyze .board-caption")).toMatch(/color: var\(--text\)/);
  });

  it("names the game in the bar under the board instead", () => {
    // The one place on a wide screen that names the loaded game. The strip's
    // copy of the name is gone with the strip; the bar's slot is empty while no
    // game is loaded (the board's start position explains itself).
    const bar = analyze.slice(analyze.indexOf('class="board-bar"'), analyze.indexOf('id="analyze-sidebar"'));
    expect(bar).toContain('id="analysis-board-caption"');
    expect(bar).not.toContain('id="analysis-board-label"');
    // The navigation and the flip button are the bar's untouched chrome.
    for (const id of ["analysis-prev", "analysis-next", "analysis-flip"]) expect(bar).toContain(`id="${id}"`);
  });
});
