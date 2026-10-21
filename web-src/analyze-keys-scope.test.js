// The keyboard row that steps a game belongs to the board on screen. The
// document-level handler cannot be released when a view is left, so it must ask
// which view is showing: ← → on Games (or Library, Scout, Teams, Settings) used
// to step Analyze's board behind them, and coming back to Analyze showed a
// different move than the one the user left on.
import { describe, expect, it } from "vitest";

import { appSource } from "./test-app-source.js";

const source = appSource();

// The body of the app's one document keydown handler that steps a board, up to
// the first listener after it (the click handler, which follows it).
function stepsBoardBlock() {
  const start = source.indexOf("// Arrow keys navigate the board of the view that is on screen");
  expect(start).toBeGreaterThan(0);
  return source.slice(start, source.indexOf('document.addEventListener("click"', start));
}

describe("arrow keys and the board on screen", () => {
  it("steps a board only on the views that have one", () => {
    const block = stepsBoardBlock();
    expect(block).toMatch(/const stepsBoard = inBuild \|\| view === "analyze";/);
    // Every stepping branch asks that guard; none runs unguarded.
    expect(block).toMatch(/if \(stepsBoard && event\.key === "ArrowLeft"\)/);
    expect(block).toMatch(/if \(stepsBoard && event\.key === "ArrowRight"\)/);
    expect(block).toMatch(/if \(stepsBoard && \(event\.key === "Home" \|\| event\.key === "End"\)\)/);
    expect(block.match(/analysisTreeNav\(/g) || []).toHaveLength(3);
    for (const call of block.split("analysisTreeNav(").slice(1)) {
      expect(block.slice(0, block.indexOf(call))).toMatch(/stepsBoard/);
    }
  });

  it("reads the view from the one source the shell uses", () => {
    expect(source).toMatch(/const view = activeViewName\(\);/);
    expect(stepsBoardBlock()).toMatch(/view === "build"/);
  });

  it("does not answer an engine line left over from another view", () => {
    // A preview belongs to a board; on a view without one it must not swallow
    // ← → (the arrows would step a hidden board).
    const i = source.indexOf("if (engineWidget && engineWidget.isPreviewing()");
    expect(i).toBeGreaterThan(0);
    expect(source.slice(i, i + 160)).toMatch(/view === "analyze" \|\| view === "build"/);
  });

  it("keeps F and Escape on every view", () => {
    // These are not board steps: the flip follows the active board controller
    // (null on a view without one) and Escape closes what is open anywhere.
    const i = source.indexOf('// F flips the active tab');
    const block = source.slice(i, i + 700);
    expect(block).toMatch(/activeBoardController\(\)/);
    expect(block).not.toMatch(/analysisTreeNav|buildGo/);
  });
});
