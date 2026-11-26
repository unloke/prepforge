import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createGeneratePreview } from "./generate-preview.js";
import { createMoveTreeRenderer } from "../views/shared/movetree.js";
import { createBuildView } from "../views/build.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const add = (tempId, parentRef, moveUci) => ({ action: "planned_add", tempId, parentRef, moveUci });
function harness() {
  const root = { id: "root", depth: 0, fen: START };
  const build = { nodes: [root] };
  const byId = new Map([[root.id, root]]);
  let current = true, frame, fallback;
  const render = vi.fn();
  const cancelFrame = vi.fn(), cancelLater = vi.fn(), onClear = vi.fn();
  const preview = createGeneratePreview({ byId, render, onClear, isCurrent: () => current,
    frame: vi.fn((fn) => { frame = fn; return 1; }), cancelFrame,
    later: vi.fn((fn) => { fallback = fn; return 2; }), cancelLater,
  });
  return { build, byId, preview, render, cancelFrame, cancelLater, onClear,
    frame: () => frame(), fallback: () => fallback(), leave: () => { current = false; } };
}

describe("generation preview", () => {
  it("resolves temporary parents and batches a burst into one frame", () => {
    const h = harness();
    h.preview.add(add("tmp-1", "root", "e2e4"));
    h.preview.add(add("tmp-2", "tmp-1", "e7e5"));
    expect(h.render).not.toHaveBeenCalled();
    expect(h.preview.node("tmp-2")).toMatchObject({ parent_id: "tmp-1", san: "e5", depth: 2, preview: true });
    expect(h.build.nodes).toEqual([h.byId.get("root")]);
    expect(h.byId.has("tmp-1")).toBe(false);
    expect(h.preview.childrenOf("root", [{ id: "saved" }]).map((node) => node.id)).toEqual(["saved", "tmp-1"]);
    expect(h.preview.childrenOf("tmp-1", []).map((node) => node.id)).toEqual(["tmp-2"]);
    h.frame();
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.cancelLater).toHaveBeenCalledWith(2);
  });

  it("renders through the timeout when animation frames are suspended", () => {
    const h = harness();
    h.preview.add(add("tmp-1", "root", "e2e4"));
    h.fallback();
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.cancelFrame).toHaveBeenCalledWith(1);
  });

  it.each(["Stop", "error"])("%s removes previews and restores the prior tree", () => {
    const h = harness();
    const root = h.build.nodes[0];
    h.preview.add(add("tmp-1", "root", "e2e4"));
    h.preview.clear();
    expect(h.build.nodes).toEqual([root]);
    expect(h.preview.node("tmp-1")).toBeUndefined();
    expect(h.preview.childrenOf("root", [])).toEqual([]);
    expect(h.render).toHaveBeenCalledTimes(1);
    h.frame();
    h.preview.add(add("tmp-2", "root", "d2d4"));
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.byId.size).toBe(1);
  });

  it("clears on context loss without painting the new repertoire", () => {
    const h = harness();
    h.preview.add(add("tmp-1", "root", "e2e4"));
    h.leave();
    h.frame();
    expect(h.byId.size).toBe(1);
    expect(h.render).not.toHaveBeenCalled();
  });

  it("aborts once on cleanup and does not retain previews after hydration", () => {
    const h = harness();
    h.preview.add(add("tmp-1", "root", "e2e4"));
    h.preview.clear(false);
    h.preview.clear();
    expect(h.byId.size).toBe(1);
    expect(h.onClear).toHaveBeenCalledTimes(1);
    expect(h.render).not.toHaveBeenCalled();
  });

  it("renders disabled preview tokens without a move menu", () => {
    const renderer = createMoveTreeRenderer();
    const tree = { children: [{ id: "tmp-1", san: "e4", side: "white", moveNumber: 1, children: [] }] };
    const html = String(renderer.renderMoveTree(tree, { moveMenu: true, decorate: () => ({ disabled: true }) }));
    expect(html).toContain(" disabled");
    expect(html).not.toContain("mtree-more");
  });

  it("does not change existing nodes for updates or mainline changes", () => {
    const h = harness();
    h.preview.add({ action: "updated", nodeId: "root", source: "generated_stockfish" });
    h.preview.add({ action: "set_mainline", nodeRef: "root" });
    expect(h.build.nodes).toEqual([{ id: "root", depth: 0, fen: START }]);
    expect(h.render).not.toHaveBeenCalled();
    h.preview.clear();
    expect(h.byId.size).toBe(1);
  });
});

describe("Generate controller integration", () => {
  const source = readFileSync(new URL("./build-session.js", import.meta.url), "utf8");
  it("discards on Stop and checks abort before the only save", () => {
    const generate = source.slice(source.indexOf("async function generateFromCurrentNode()"), source.indexOf("function openNodeContextMenu"));
    expect(generate).toContain("onCancel: () => preview.clear()");
    expect(generate).toContain("onClear: () => controller.abort()");
    expect(generate.indexOf("if (controller.signal.aborted)")).toBeLessThan(generate.indexOf('"/api/build/generate/apply-plan"'));
    expect(generate).toContain('if (ev?.type === "change")');
    expect(generate).toMatch(/finally \{[\s\S]*preview.clear\(\)/);
  });
  it("clears the separate preview on hydration", () => {
    expect(source).toContain("buildState.buildGenerationPreview?.clear(false)");
  });
});

describe("preview rendering with the shared Build index", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("patches a variation using raw nodes and the indexed children", () => {
    const h = harness();
    h.preview.add(add("tmp-1", "root", "e2e4"));
    const appState = { build: { ...h.build, repertoire_id: "rep", color: "white" },
      buildNodeById: h.byId, buildCurrentNodeId: "root", buildGenerationPreview: h.preview };
    const container = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: (id) => id === "builder-tree" ? container : null });
    vi.stubGlobal("CSS", { escape: (id) => id });
    const renderer = { ...createMoveTreeRenderer(), bindMoveTreeClicks: vi.fn() };
    const view = createBuildView({ appState, buildState: appState, boards: {}, getMoveTreeRenderer: () => renderer,
      ensureMoveTreeRenderer: async () => renderer, selectBuildNode: vi.fn(),
      openNodeContextMenu: vi.fn(), buildBranchContext: () => null });
    view.renderBuilderTree();
    const variation = { outerHTML: "", querySelector: () => ({ dataset: { collapseId: "tmp-1" } }) };
    container.querySelector = () => ({ closest: () => variation });
    h.preview.add(add("tmp-2", "tmp-1", "e7e5"));
    view.renderGeneratePreview(new Set(["tmp-1"]));
    expect(variation.outerHTML).toContain('data-node-id="tmp-2"');
    expect(variation.outerHTML).toContain('class="mtree-san">e5');
    expect(variation.outerHTML).toContain(" disabled");
    h.preview.clear(false);
  });
});
