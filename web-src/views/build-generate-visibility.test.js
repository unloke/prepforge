import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBuildView } from "./build.js";

// Generate's head button follows ONE rule: it applies when a writable
// repertoire is loaded, its current position is settled, and no move of your
// own already answers it there. Where it does not apply the ⋯ menu's
// "Move …" entry still reaches it.
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

function makeHarness({ nodes, currentNodeId, color = "black", readOnly = false, loading = false }) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const appState = {
    build: { nodes, color, repertoire_id: "rep-1", writable: !readOnly },
    buildNodeById: nodeById,
    buildCurrentNodeId: currentNodeId,
    buildBranchChoiceId: null,
    buildLoading: loading,
  };
  const generateBtn = { hidden: true, classList: { toggle: vi.fn() } };
  const elements = {
    "build-rep-name": { get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); } },
    "build-branchbar": { hidden: true, set innerHTML(v) {}, querySelectorAll: vi.fn(() => []) },
    "build-tree-meta": { hidden: true, set innerHTML(v) {}, querySelectorAll: vi.fn(() => []) },
    "builder-tree": { set innerHTML(v) {}, querySelector: vi.fn(() => null), querySelectorAll: vi.fn(() => []) },
    "build-generate-node": generateBtn,
    "build-empty": { hidden: false },
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
    isReadOnly: () => readOnly,
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

  // --- the states that used to leak through -------------------------------
  it("stays hidden in a read-only shared repertoire", () => {
    // A share link renders someone else's tree with no write access. The position
    // "applies" (no reply of your own under it) but the action cannot run — the
    // controller bails with "Read-only" — so the button must not appear.
    const { view, generateBtn } = makeHarness({ nodes: tree(), currentNodeId: "d5", readOnly: true });
    view.renderBuildRepHeader();
    expect(generateBtn.hidden).toBe(true);
  });

  it("stays hidden while a repertoire is loading", () => {
    // editRepertoire() puts a skeleton in the tree and keeps the view inert
    // until the new payload lands. The rule's subject is still the previous
    // repertoire, so the head must drop the button instead of showing it.
    const { view, generateBtn } = makeHarness({ nodes: tree(), currentNodeId: "d5", loading: true });
    view.renderBuildRepHeader();
    expect(generateBtn.hidden).toBe(true);
  });

  it("repaints from every tree branch, not only the rendered one", () => {
    // The no-repertoire branch returns before the move-tree renderer runs. It
    // used to skip the head paint, so Generate kept the deleted tree's state.
    const { view, generateBtn, appState } = makeHarness({ nodes: tree(), currentNodeId: "d5" });
    view.renderBuilderTree();
    expect(generateBtn.hidden).toBe(false);
    appState.build = null;
    appState.buildCurrentNodeId = null;
    view.renderBuilderTree();
    expect(generateBtn.hidden).toBe(true);
  });

  it("repaints the root-only branch a new repertoire renders", () => {
    // A newly created repertoire renders its root only, which also returns
    // before the tree renderer runs. The first move of the line is yours to
    // find, so the button applies there.
    const { view, generateBtn } = makeHarness({
      nodes: [makeNode({ id: "root" })],
      currentNodeId: "root",
    });
    view.renderBuilderTree();
    expect(generateBtn.hidden).toBe(false);
  });

  it("follows a repertoire flipping to read-only under the cursor", () => {
    // Signing in to a shared link (or signing out of one) re-hydrates the same
    // position under a different write access. The rule re-reads the flag on the
    // next paint instead of keeping the writable answer.
    const writable = makeHarness({ nodes: tree(), currentNodeId: "d5" });
    writable.view.renderBuildRepHeader();
    expect(writable.generateBtn.hidden).toBe(false);
    const shared = makeHarness({ nodes: tree(), currentNodeId: "d5", readOnly: true });
    shared.view.renderBuildRepHeader();
    expect(shared.generateBtn.hidden).toBe(true);
  });
});
