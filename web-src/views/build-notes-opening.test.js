import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { createBuildView } from "./build.js";
import { createMoveTreeRenderer } from "./shared/movetree.js";

// A repertoire's notes read in the tree, under their moves; the line's named
// opening sits at the end of the position trail; and every move has a pointer
// path to its menu.
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function harness({ readOnly = false } = {}) {
  const nodes = [
    { id: "root", parent_id: null, depth: 0, san: "root", fen: START, move_number: 1, move_side: "white", is_mainline: true, is_enabled: true },
    { id: "e4", parent_id: "root", depth: 1, san: "e4", uci: "e2e4", fen: AFTER_E4, move_number: 1, move_side: "white", is_mainline: true, is_enabled: true, comment: "Best by test. 1...c5 is the Sicilian." },
    { id: "c5", parent_id: "e4", depth: 2, san: "c5", uci: "c7c5", fen: AFTER_C5, move_number: 1, move_side: "black", is_mainline: true, is_enabled: true },
  ];
  const appState = {
    build: { nodes, color: "white", repertoire_id: "rep-1" },
    buildNodeById: new Map(nodes.map((n) => [n.id, n])),
    buildCurrentNodeId: "c5",
    buildOpeningByFen: new Map([[AFTER_C5.split(" ").slice(0, 4).join(" "), "B20 Sicilian Defense"]]),
  };
  const el = (extra = {}) => ({
    hidden: false, textContent: "", title: "",
    get innerHTML() { return this._html ?? ""; }, set innerHTML(v) { this._html = String(v); },
    querySelector: () => null, querySelectorAll: () => [], ...extra,
  });
  const elements = { "builder-tree": el(), "build-tree-meta": el(), "build-branchbar": el(), "build-opening": el(), "build-generate-node": el() };
  globalThis.document = { getElementById: (id) => elements[id] || null, querySelector: () => null };
  const renderer = createMoveTreeRenderer();
  const view = createBuildView({
    appState,
    boards: { build: { setBranchArrows: vi.fn() } },
    getMoveTreeRenderer: () => ({ ...renderer, bindMoveTreeClicks: vi.fn(), scrollIntoViewWithin: vi.fn() }),
    ensureMoveTreeRenderer: () => Promise.resolve(),
    selectBuildNode: vi.fn(),
    openNodeContextMenu: vi.fn(),
    buildBranchContext: () => null,
    isReadOnly: () => readOnly,
  });
  return { view, elements, appState };
}

describe("Build tree notes, opening and move menu", () => {
  afterEach(() => { globalThis.document = undefined; });

  it("puts a note under its move, with its moves as live tokens", () => {
    const { view, elements } = harness();
    view.renderBuilderTree();
    const tree = elements["builder-tree"].innerHTML;
    expect(tree).toMatch(/<\/button><div class="mtree-comment" data-note-for="e4">Best by test\. /);
    expect(tree).toContain('class="move-ref"');
    // The note is no longer a dot with a tooltip, nor a second copy under the trail.
    expect(tree).not.toContain("mtree-note");
    expect(elements["build-tree-meta"].innerHTML).not.toContain("build-comment");
  });

  it("names the line's opening at the deepest named position", () => {
    const { view, elements, appState } = harness();
    view.renderBuilderTree();
    expect(elements["build-opening"].textContent).toBe("B20 Sicilian Defense");
    expect(elements["build-opening"].hidden).toBe(false);
    appState.buildCurrentNodeId = "e4";
    view.renderBuildOpening();
    expect(elements["build-opening"].hidden).toBe(true);
  });

  it("gives every editable move a hover ⋯ for its menu, and none on a read-only tree", () => {
    const editable = harness();
    editable.view.renderBuilderTree();
    expect(editable.elements["builder-tree"].innerHTML.match(/class="mtree-more"/g)).toHaveLength(2);
    const shared = harness({ readOnly: true });
    shared.view.renderBuilderTree();
    expect(shared.elements["builder-tree"].innerHTML).not.toContain("mtree-more");
  });
});

describe("Ctrl/Cmd+Z in Repertoire", () => {
  const session = readFileSync(new URL("../controllers/build-session.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../build-entry.js", import.meta.url), "utf8");

  it("takes back the newest move this tab added through the ordinary delete", () => {
    expect(session).toContain("appState.buildAddedIds.push({ repertoireId: appState.build.repertoire_id, id: node.id });");
    const undo = entry.slice(entry.indexOf("export async function undoLastBuildAdd("), entry.indexOf("export async function deleteBuildNodeLocal("));
    expect(undo).toContain("if (entry.repertoireId !== appState.build.repertoire_id || !appState.buildNodeById.has(id)) continue;");
    expect(undo).toContain("await deleteBuildNodeLocal(id);");
  });

  it("answers only on the Repertoire view and not while typing", () => {
    const keys = app.slice(app.indexOf("const inEditable"), app.indexOf("const inBuild = view"));
    expect(keys).toMatch(/view === "build" && \(event\.ctrlKey \|\| event\.metaKey\) && !event\.shiftKey/);
    expect(keys).toContain("return void undoLastBuildAdd();");
  });
});
