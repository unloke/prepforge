import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBuildView } from "./build.js";

// Characterization for the ui-prototype-v2 workspace internals:
//  - fork chips show each continuation's real practical share
//    (maia_probability — the server-stored human-likeness of the move) and omit
//    the value when the server has none (manual/imported nodes), never faking one;
//  - the move list carries a mastery legend mirroring the heatmap classes the
//    tree actually paints (mastered/learning/due/weak), only when such nodes exist.

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

function makeHarness({ nodes, currentNodeId, ownNodes = 0 }) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const appState = {
    build: { nodes, color: "black", repertoire_id: "rep-1" },
    buildNodeById: nodeById,
    buildCurrentNodeId: currentNodeId,
    buildBranchChoiceId: null,
  };
  const bar = {
    hidden: true,
    innerHTML: "",
    setAttribute: vi.fn(),
    querySelectorAll: vi.fn(() => []),
  };
  const meta = {
    hidden: true,
    innerHTML: "",
    querySelectorAll: vi.fn(() => []),
  };
  const container = {
    innerHTML: "",
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn((sel) => {
      if (sel.startsWith(".mtree-collapse")) return [];
      if (sel.startsWith(".mtree-crumb")) return [];
      return [];
    }),
  };
  const elements = {
    "build-rep-name": { innerHTML: "" },
    "build-branchbar": bar,
    "build-tree-meta": meta,
    "builder-tree": container,
  };
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
  };
  const boards = { build: { setBranchArrows: vi.fn() } };
  const view = createBuildView({
    appState,
    escapeHtml: (s) => String(s),
    boards,
    getMoveTreeRenderer: () => ({
      renderMoveTree: () => '<div class="mtree"></div>',
      bindMoveTreeClicks: () => {},
      scrollIntoViewWithin: () => {},
    }),
    ensureMoveTreeRenderer: () => Promise.resolve(),
    selectBuildNode: vi.fn(),
    openNodeContextMenu: vi.fn(),
    buildBranchContext: () => {
      const options = appState.build.nodes.filter(
        (n) => n.parent_id === appState.buildCurrentNodeId,
      );
      if (options.length < 2) return null;
      const picked =
        options.find((n) => n.id === appState.buildBranchChoiceId) || options[0];
      return { options, choiceId: picked.id };
    },
  });
  return { view, bar, container, meta, appState };
}

describe("build branch bar — practical share", () => {
  beforeEach(() => {
    globalThis.document = undefined;
  });
  afterEach(() => {
    globalThis.document = undefined;
  });

  it("shows the real maia probability on each chip", () => {
    const e5 = makeNode({
      id: "e5", depth: 1, parent_id: "root", san: "e5", uci: "e7e5",
      move_side: "black", is_mainline: true, maia_probability: 0.481,
    });
    const c5 = makeNode({
      id: "c5", depth: 1, parent_id: "root", san: "c5", uci: "c7c5",
      move_side: "black", maia_probability: 0.312,
    });
    const { view, bar } = makeHarness({
      nodes: [makeNode({ id: "root" }), e5, c5],
      currentNodeId: "root",
    });
    view.renderBuildBranchBar();
    expect(bar.hidden).toBe(false);
    expect(bar.innerHTML).toContain("48%");
    expect(bar.innerHTML).toContain("31%");
  });

  it("omits the share when the server has no probability (manual moves)", () => {
    const e5 = makeNode({
      id: "e5", depth: 1, parent_id: "root", san: "e5", uci: "e7e5",
      move_side: "black", is_mainline: true, maia_probability: null,
    });
    const c5 = makeNode({
      id: "c5", depth: 1, parent_id: "root", san: "c5", uci: "c7c5",
      move_side: "black", maia_probability: null,
    });
    const { view, bar } = makeHarness({
      nodes: [makeNode({ id: "root" }), e5, c5],
      currentNodeId: "root",
    });
    view.renderBuildBranchBar();
    expect(bar.innerHTML).not.toContain("<small>");
  });
});

describe("build tree — mastery legend", () => {
  beforeEach(() => {
    globalThis.document = undefined;
  });
  afterEach(() => {
    globalThis.document = undefined;
  });

  it("renders the legend when own-side nodes carry mastery", () => {
    const e5 = makeNode({
      id: "e5", depth: 1, parent_id: "root", san: "e5", uci: "e7e5",
      move_side: "black", is_mainline: true, mastery: "mastered",
    });
    const c6 = makeNode({
      id: "c6", depth: 2, parent_id: "e5", san: "c6", uci: "c7c6",
      move_side: "black", mastery: "weak",
    });
    const { view, meta } = makeHarness({
      nodes: [makeNode({ id: "root" }), e5, c6],
      currentNodeId: "e5",
    });
    view.renderBuilderTree();
    expect(meta.innerHTML).toContain("legend");
    expect(meta.innerHTML).toContain("mastered");
    expect(meta.innerHTML).toContain("weak");
  });

  it("omits the legend when nothing is trained yet", () => {
    const e5 = makeNode({
      id: "e5", depth: 1, parent_id: "root", san: "e5", uci: "e7e5",
      move_side: "black", is_mainline: true, mastery: null,
    });
    const { view, meta } = makeHarness({
      nodes: [makeNode({ id: "root" }), e5],
      currentNodeId: "root",
    });
    view.renderBuilderTree();
    expect(meta.innerHTML).not.toContain("legend");
  });
});
