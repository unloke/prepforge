import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBuildView } from "./build.js";

// A fork can hold thirty continuations (a generated tree leaves one chip for
// every reply). Painted whole, six rows of "Next move" took the panel's height
// from the move tree: at 1024x768 the tree fell to its 90px floor, which is
// three rows of the line you are building. The bar now paints a window of
// chips that always contains the pick and opens the rest on request.

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
    mastery: null,
    maia_probability: null,
    ...overrides,
  };
}

function rootWithFork(count, choiceId = null) {
  const root = makeNode({ id: "root" });
  const options = [];
  for (let i = 0; i < count; i += 1) {
    options.push(
      makeNode({
        id: `o${i}`,
        parent_id: "root",
        depth: 1,
        san: `m${i}`,
        uci: `a7a${i % 8}`,
        move_side: "white",
        is_mainline: i === 0,
      }),
    );
  }
  return { nodes: [root, ...options], root, options, choiceId };
}

function makeHarness({ nodes, currentNodeId, choiceId }) {
  const buttons = [];
  const makeEl = () => {
    const el = {
      hidden: true,
      _html: "",
      get innerHTML() {
        return this._html;
      },
      set innerHTML(value) {
        this._html = String(value);
      },
      setAttribute: vi.fn(),
      querySelector: (sel) => {
        if (sel === ".fork-more") {
          const hit = {
            addEventListener: (type, fn) => { hit[`on${type}`] = fn; },
            focus: vi.fn(),
          };
          return String(el._html).includes("fork-more") ? hit : null;
        }
        return null;
      },
      querySelectorAll: (sel) => {
        if (!sel.startsWith(".fork-chip")) return [];
        return [...String(el._html).matchAll(/data-node-id="([^"]+)"[^>]*title="Play/g)].map((m) => {
          const button = { dataset: { nodeId: m[1] }, addEventListener: vi.fn(), blur: vi.fn() };
          buttons.push(button);
          return button;
        });
      },
    };
    return el;
  };
  const elements = {
    "build-rep-name": makeEl(),
    "build-branchbar": makeEl(),
    "build-tree-meta": makeEl(),
    "builder-tree": makeEl(),
  };
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
  };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  const appState = {
    build: { nodes, color: "white", repertoire_id: "rep-1" },
    buildNodeById: new Map(nodes.map((n) => [n.id, n])),
    buildCurrentNodeId: currentNodeId,
    buildBranchChoiceId: choiceId,
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
    buildBranchContext: () => {
      const options = nodes.filter((n) => n.parent_id === currentNodeId);
      if (options.length < 2) return null;
      const picked = options.find((n) => n.id === appState.buildBranchChoiceId) || options[0];
      return { options, choiceId: picked.id };
    },
  });
  return { view, bar: elements["build-branchbar"], appState };
}

const chipIds = (markup) => [...String(markup).matchAll(/class="fork-chip[^"]*" type="button" data-node-id="([^"]+)"/g)].map((m) => m[1]);

describe("build fork bar — a wide fork is a window, not six rows", () => {
  beforeEach(() => {
    globalThis.document = undefined;
  });
  afterEach(() => {
    globalThis.document = undefined;
    globalThis.window = undefined;
  });

  it("paints eight chips of thirty, the first eight, and offers the rest", () => {
    const { nodes, root } = rootWithFork(30);
    const { view, bar } = makeHarness({ nodes, currentNodeId: root.id });
    view.renderBuildBranchBar();
    expect(chipIds(bar.innerHTML)).toEqual(["o0", "o1", "o2", "o3", "o4", "o5", "o6", "o7"]);
    expect(String(bar.innerHTML)).toContain('class="fork-more"');
    expect(String(bar.innerHTML)).toContain("Show all");
    // The count still states the whole fork: the window never hides how many
    // options there are, it hides the unpicked ones.
    expect(String(bar.innerHTML)).toContain("30 options");
  });

  it("keeps the pick inside the window and slides it when the pick moves on", () => {
    const { nodes, root, options } = rootWithFork(30, "o20");
    const { view, bar } = makeHarness({ nodes, currentNodeId: root.id, choiceId: "o20" });
    view.renderBuildBranchBar();
    const shown = chipIds(bar.innerHTML);
    expect(shown).toHaveLength(8);
    expect(shown).toContain("o20");
    expect(String(bar.innerHTML)).toMatch(/class="fork-chip[^"]*is-active[^"]*" type="button" data-node-id="o20"/);
    // The window centres on the pick rather than pinning it to an edge, so
    // the moves just before and after the choice are readable together.
    expect(shown.indexOf("o20")).toBe(4);
    // A pick near the end clamps the window against the end, never past it.
    const last = rootWithFork(30, options[options.length - 1].id);
    const harness = makeHarness({ nodes: last.nodes, currentNodeId: root.id, choiceId: options[options.length - 1].id });
    harness.view.renderBuildBranchBar();
    const tail = chipIds(harness.bar.innerHTML);
    expect(tail[tail.length - 1]).toBe(options[options.length - 1].id);
  });

  it("shows every chip when the fork fits, and offers nothing to open", () => {
    const { nodes, root } = rootWithFork(3);
    const { view, bar } = makeHarness({ nodes, currentNodeId: root.id });
    view.renderBuildBranchBar();
    expect(chipIds(bar.innerHTML)).toEqual(["o0", "o1", "o2"]);
    expect(String(bar.innerHTML)).not.toContain("fork-more");
  });

  it("opens the whole list on request, inside a capped block", () => {
    const { nodes, root } = rootWithFork(30);
    const { view, bar } = makeHarness({ nodes, currentNodeId: root.id });
    view.renderBuildBranchBar();
    // The disclosure is a button with real expanded state, not a link.
    expect(String(bar.innerHTML)).toContain('aria-expanded="false"');
    expect(String(bar.innerHTML)).not.toContain("is-all");
  });
});
