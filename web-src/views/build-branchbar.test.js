import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBuildView } from "./build.js";
import { createMoveTreeRenderer } from "./shared/movetree.js";
import { asSlices } from "../state/as-slices.fixture.js";

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

function makeHarness({ nodes, currentNodeId, renderer }) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const appState = {
    build: { nodes, color: "black", repertoire_id: "rep-1" },
    buildNodeById: nodeById,
    buildCurrentNodeId: currentNodeId,
    buildBranchChoiceId: null,
  };
  const bar = {
    hidden: true,
    get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
    setAttribute: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
  };
  const meta = {
    hidden: true,
    get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
    querySelectorAll: vi.fn(() => []),
  };
  const container = {
    get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
    querySelector: vi.fn(() => null),
    addEventListener: vi.fn(),
    querySelectorAll: vi.fn((sel) => {
      if (sel.startsWith(".mtree-collapse")) return [];
      if (sel.startsWith(".mtree-crumb")) return [];
      return [];
    }),
  };
  const elements = {
    "build-rep-name": { get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); } },
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
    ...asSlices(appState), 
    boards,
    getMoveTreeRenderer: () => renderer || ({
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
  return { view, bar, container, meta, ...asSlices(appState), appState,  };
}

function variationToggle(container, id) {
  const variation = { outerHTML: "" };
  const toggle = { dataset: { collapseId: id }, closest: () => variation };
  const [, onClick] = container.addEventListener.mock.calls.find(([event]) => event === "click");
  return () => {
    onClick({ target: { closest: (sel) => sel.includes("mtree-collapse") ? toggle : null }, stopPropagation: vi.fn() });
    return variation.outerHTML;
  };
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
    expect(String(bar.innerHTML)).toContain("48%");
    expect(String(bar.innerHTML)).toContain("31%");
  });

  it("marks the mainline by weight, not by a glyph or a mastery colour", () => {
    const e5 = makeNode({
      id: "e5", depth: 1, parent_id: "root", san: "e5", uci: "e7e5",
      move_side: "black", is_mainline: true,
    });
    const c5 = makeNode({
      id: "c5", depth: 1, parent_id: "root", san: "c5", uci: "c7c5",
      move_side: "black", is_mainline: false,
    });
    const { view, bar } = makeHarness({
      nodes: [makeNode({ id: "root" }), e5, c5],
      currentNodeId: "root",
    });
    view.renderBuildBranchBar();
    const markup = String(bar.innerHTML);
    const main = markup.match(/<button[^>]*data-node-id="e5"[^>]*>/)[0];
    const off = markup.match(/<button[^>]*data-node-id="c5"[^>]*>/)[0];
    expect(main).toContain("is-main");
    expect(off).not.toContain("is-main");
    // The chip carried a star that was an emoji and reused the "due" colour,
    // reading as a training prompt; it must stay text.
    expect(markup).not.toContain("★");
    expect(main).toContain("main line");
    expect(off).not.toContain("main line");
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
    expect(String(bar.innerHTML)).not.toContain("<small>");
  });
});

describe("build tree — mastery legend", () => {
  beforeEach(() => {
    globalThis.document = undefined;
  });
  afterEach(() => {
    globalThis.document = undefined;
  });

  it("draws no standing legend when nodes carry mastery", () => {
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
    expect(String(meta.innerHTML)).not.toContain("legend");
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
    expect(String(meta.innerHTML)).not.toContain("legend");
  });
});

describe("build tree — large repertoire auto-collapse", () => {
  beforeEach(() => {
    globalThis.document = undefined;
  });
  afterEach(() => {
    globalThis.document = undefined;
  });

  it("collapses off-path variations on initial open for trees > 250 nodes while keeping active path expanded", () => {
    const root = makeNode({ id: "root", depth: 0 });
    const main = makeNode({ id: "main-0", parent_id: "root", depth: 1, san: "e4", uci: "e2e4", is_mainline: true });
    const offPathVar = makeNode({ id: "var-0", parent_id: "root", depth: 1, san: "d4", uci: "d2d4" });
    const activeVar = makeNode({ id: "active-0", parent_id: "root", depth: 1, san: "c4", uci: "c2c4" });
    const leaf = makeNode({ id: "active-1", parent_id: activeVar.id, depth: 2, san: "e5", uci: "e7e5" });
    // Put an alternative before the flagged mainline, as a server payload can.
    const nodes = [root, offPathVar, main, activeVar, leaf];
    let prev = main;
    for (let i = 1; i < 260; i += 1) {
      const next = makeNode({
        id: `m-${i}`,
        parent_id: prev.id,
        depth: i + 1,
        san: i % 2 === 1 ? "e5" : "Nf3",
        uci: i % 2 === 1 ? "e7e5" : "g1f3",
        move_side: i % 2 === 1 ? "black" : "white",
        is_mainline: true,
      });
      nodes.push(next);
      prev = next;
    }
    const { view, appState, container } = makeHarness({
      nodes, currentNodeId: leaf.id, renderer: createMoveTreeRenderer(),
    });
    view.renderBuilderTree();
    expect(container.innerHTML).toContain('data-collapse-id="var-0" title="Expand 1.d4 variation"');
    expect(container.innerHTML).not.toContain('data-node-id="var-0"');
    expect(container.innerHTML).not.toContain('data-collapse-id="main-0"');
    expect(container.innerHTML).toContain('data-node-id="active-1"');
    expect(container.innerHTML).toMatch(/is-current[^>]*data-node-id="active-1"/);

    const toggle = variationToggle(container, offPathVar.id);
    expect(toggle()).toContain('data-node-id="var-0"');
    view.renderBuilderTree();
    expect(container.innerHTML).toContain('data-node-id="var-0"');

    expect(toggle()).not.toContain('data-node-id="var-0"');
    appState.buildCurrentNodeId = offPathVar.id;
    view.updateBuildTreeSelection();
    expect(container.innerHTML).toMatch(/is-current[^>]*data-node-id="var-0"/);

    toggle();
    appState.build = { ...appState.build, name: "Renamed" };
    view.updateBuildTreeSelection();
    expect(container.innerHTML).not.toContain('data-node-id="var-0"');

    appState.build = { ...appState.build, repertoire_id: "another-repertoire" };
    appState.buildCurrentNodeId = root.id;
    view.renderBuilderTree();
    expect(container.innerHTML).not.toContain('data-node-id="var-0"');
  });

  it("preserves manual collapse in a small repertoire after opening another", () => {
    const root = makeNode({ id: "root" });
    const main = makeNode({ id: "main", parent_id: root.id, depth: 1, san: "e4", is_mainline: true });
    const variation = makeNode({ id: "var", parent_id: root.id, depth: 1, san: "d4" });
    const { view, appState, container } = makeHarness({
      nodes: [root, main, variation], currentNodeId: root.id, renderer: createMoveTreeRenderer(),
    });
    const original = appState.build;
    const originalIndex = appState.buildNodeById;
    view.renderBuilderTree();
    expect(variationToggle(container, variation.id)()).toContain('title="Expand 1.d4 variation"');

    const otherNodes = original.nodes.map((n) => ({ ...n, id: `other-${n.id}`, parent_id: n.parent_id && `other-${n.parent_id}` }));
    appState.build = { ...original, nodes: otherNodes, repertoire_id: "other" };
    appState.buildNodeById = new Map(otherNodes.map((n) => [n.id, n]));
    appState.buildCurrentNodeId = otherNodes[0].id;
    view.renderBuilderTree();
    expect(container.innerHTML).toContain('data-node-id="other-var"');

    appState.build = { ...original };
    appState.buildNodeById = originalIndex;
    appState.buildCurrentNodeId = root.id;
    view.renderBuilderTree();
    expect(container.innerHTML).toContain('data-collapse-id="var" title="Expand 1.d4 variation"');
    expect(container.innerHTML).not.toContain('data-node-id="var"');
  });

  it("reveals the selected variation after its ID changes or a fresh open targets it", () => {
    const root = makeNode({ id: "root" });
    const main = makeNode({ id: "main", parent_id: root.id, depth: 1, san: "e4", is_mainline: true });
    const variation = makeNode({ id: "tmp-1", parent_id: root.id, depth: 1, san: "d4" });
    const filler = Array.from({ length: 250 }, (_, i) => makeNode({ id: `filler-${i}`, parent_id: main.id, depth: 2, san: "d5" }));
    const nodes = [root, main, variation, ...filler];
    const { view, appState, container } = makeHarness({
      nodes, currentNodeId: variation.id, renderer: createMoveTreeRenderer(),
    });
    view.renderBuilderTree();
    expect(container.innerHTML).toMatch(/is-current[^>]*data-node-id="tmp-1"/);

    const saved = { ...variation, id: "saved-var" };
    const savedNodes = [root, main, saved, ...filler];
    appState.build = { ...appState.build, nodes: savedNodes };
    appState.buildNodeById = new Map(savedNodes.map((n) => [n.id, n]));
    appState.buildCurrentNodeId = saved.id;
    view.updateBuildTreeSelection();
    expect(container.innerHTML).toMatch(/is-current[^>]*data-node-id="saved-var"/);

    expect(variationToggle(container, saved.id)()).not.toContain('data-node-id="saved-var"');
    appState.build = { ...appState.build };
    appState.buildLoading = true;
    view.updateBuildTreeSelection();
    expect(container.innerHTML).not.toContain('data-node-id="saved-var"');

    appState.build = { ...appState.build };
    view.updateBuildTreeSelection({ revealSelection: true });
    expect(container.innerHTML).toMatch(/is-current[^>]*data-node-id="saved-var"/);
  });
});
