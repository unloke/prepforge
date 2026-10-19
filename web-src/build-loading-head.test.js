// Regression: the loading skeleton must not keep the previous repertoire's
// Generate button, and the tree's no-repertoire branch must repaint the head.
import { html } from "./html.js";
import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";

const source = appSource();

function compile(marker, deps) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}

function harness() {
  const appState = { buildLoading: false, buildNodeById: new Map(), buildCurrentNodeId: null, currentView: "build", build: null };
  const painted = [];
  const deps = {
    appState,
    html,
    boards: { build: { setPosition: vi.fn(), setBranchArrows: vi.fn() } },
    paintGenerateVisibility: () => painted.push("paint"),
    switchView: vi.fn(),
    document: { getElementById: (id) => (id === "build-empty" ? { hidden: true } : null) },
    localBoardInfo: () => ({ legal_moves: [] }),
    renderBuildRepHeader: vi.fn(),
    renderBuilderTree: vi.fn(),
    syncViewHeads: vi.fn(),
  };
  const setBuildLoading = compile("function setBuildLoading(", deps);
  return { setBuildLoading, appState, painted, deps };
}

describe("build loading repaints the head's Generate", () => {
  it("repaints when the skeleton goes up", () => {
    const h = harness();
    h.setBuildLoading(true);
    expect(h.appState.buildLoading).toBe(true);
    // The rule reads buildLoading, so the paint above is what drops the button
    // the previous repertoire had made true.
    expect(h.painted).toEqual(["paint"]);
  });

  it("re-renders the tree instead when the skeleton comes down", () => {
    // The restore branch re-renders the tree, whose own paint covers it.
    const h = harness();
    h.setBuildLoading(false);
    expect(h.appState.buildLoading).toBe(false);
    expect(h.painted).toEqual([]);
  });
});
