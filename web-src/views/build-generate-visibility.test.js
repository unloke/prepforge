import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBuildView } from "./build.js";

// Generate offers *your* reply, so the head's button is shown only where it
// applies: a position with no prepared move of your own in the tree (the first
// move of a line, or past the end of one). Where a reply exists it is hidden —
// re-running would only re-search a line you already have — and the ⋯ menu's
// "Move …" entry still reaches it there.
function makeNode(overrides) {
  return {
    id: "n" + Math.random().toString(36).slice(2, 8),
    parent_id: null,
    depth: 0,
    san: null,
    uci: null,
    move_number: 1,
    ply: 0,
    move_side: "white",
    is_mainline: false,
    is_enabled: true,
    is_prepared: false,
    mastery: null,
    maia_probability: null,
    ...overrides,
  };
}

function makeHarness({ nodes, currentNodeId, color = "black" }) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const appState = {
    build: { nodes, color, repertoire_id: "rep-1" },
    buildNodeById: nodeById,
    buildCurrentNodeId: currentNodeId,
    buildBranchChoiceId: null,
  };
  const generateBtn = { hidden: true, classList: { toggle: vi.fn() } };
  const elements = {
    "build-rep-name": { get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); } },
    "build-branchbar": { hidden: true, set innerHTML(v) {}, querySelectorAll: vi.fn(() => []) },
    "build-tree-meta": { hidden: true, set innerHTML(v) {}, querySelectorAll: vi.fn(() => []) },
    "builder-tree": { set innerHTML(v) {}, querySelector: vi.fn(() => null), querySelectorAll: vi.fn(() => []) },
    "build-generate-node": generateBtn,
  };
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
  };
  const view = createBuildView({
    appState,
    boards: { build: { setBranchArrows: vi.fn() } },
    getMoveTreeRenderer: () => ({
      renderMoveTree: () => '<div class="mtree"></div>',
      bindMoveTreeClicks: () => {},
      scrollIntoViewWithin: () => {},
    }),
    ensureMoveTreeRenderer: () => Promise.resolve(),
    selectBuildNode: vi.fn(),
    openNodeContextMenu: vi.fn(),
    buildBranchContext: () => null,
  });
  return { view, generateBtn, appState };
}

describe("build Generate visibility", () => {
  beforeEach(() => { globalThis.document = undefined; });
  afterEach(() => { globalThis.document = undefined; });

  // 1.e4 c6 2.d4 d5 3.e5 Bf5 — black is your side, so the white moves are the
  // opponent's and the black ones are yours.
  const tree = () => [
    makeNode({ id: "root" }),
    makeNode({ id: "e4", parent_id: "root", depth: 1, san: "e4", uci: "e2e4", move_side: "white" }),
    makeNode({ id: "c6", parent_id: "e4", depth: 2, san: "c6", uci: "c7c6", move_side: "black", is_prepared: true }),
    makeNode({ id: "d4", parent_id: "c6", depth: 3, san: "d4", uci: "d2d4", move_side: "white" }),
    makeNode({ id: "d5", parent_id: "d4", depth: 4, san: "d5", uci: "d7d5", move_side: "black", is_prepared: true }),
    makeNode({ id: "e5", parent_id: "d5", depth: 5, san: "e5", uci: "e4e5", move_side: "white" }),
    makeNode({ id: "bf5", parent_id: "e5", depth: 6, san: "Bf5", uci: "c8f5", move_side: "black", is_prepared: true }),
  ];

  it("hides it where a prepared reply of your own already exists", () => {
    // At 3.e5 your Bf5 is already in the tree: re-running would re-search it.
    const { view, generateBtn } = makeHarness({ nodes: tree(), currentNodeId: "e5" });
    view.renderBuildRepHeader();
    expect(generateBtn.hidden).toBe(true);
  });

  it("shows it at a position awaiting your first reply", () => {
    // At 2...d5 the tree ends on your move: the next one is yours to find.
    const { view, generateBtn } = makeHarness({ nodes: tree(), currentNodeId: "d5" });
    view.renderBuildRepHeader();
    expect(generateBtn.hidden).toBe(false);
  });

  it("shows it at the empty root, before any move is played", () => {
    const { view, generateBtn } = makeHarness({ nodes: tree(), currentNodeId: "root" });
    view.renderBuildRepHeader();
    expect(generateBtn.hidden).toBe(false);
  });

  it("ignores the opponent's reply: a white child is not your prepared move", () => {
    // 1.e4 has only black's c6 under it — from white's viewpoint there is nothing
    // of yours to preserve, and with a white repertoire that node hides too.
    const white = [
      makeNode({ id: "root" }),
      makeNode({ id: "e4", parent_id: "root", depth: 1, san: "e4", uci: "e2e4", move_side: "white", is_prepared: true }),
    ];
    const { view, generateBtn } = makeHarness({ nodes: white, currentNodeId: "root", color: "white" });
    view.renderBuildRepHeader();
    expect(generateBtn.hidden).toBe(true);
  });

  it("hides it with no repertoire open", () => {
    const { view, generateBtn } = makeHarness({ nodes: [], currentNodeId: null });
    view.renderBuildRepHeader();
    expect(generateBtn.hidden).toBe(true);
  });

  it("repaints with the selection", () => {
    const { view, generateBtn, appState } = makeHarness({ nodes: tree(), currentNodeId: "e5" });
    view.renderBuildRepHeader();
    expect(generateBtn.hidden).toBe(true);
    appState.buildCurrentNodeId = "d5";
    view.renderBuildRepHeader();
    expect(generateBtn.hidden).toBe(false);
  });
});
