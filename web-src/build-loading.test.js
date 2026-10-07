import { html } from "./html.js";
import { describe, expect, it, vi } from "vitest";
import { localBoardInfo } from "./chess-local.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
function compile(marker, deps) {
  deps = { html, ...deps };
  const start = source.indexOf(marker);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function harness() {
  const parent = { id: "A-root", fen: FEN, uci: null };
  const appState = {
    currentView: "dashboard", buildLoading: false,
    build: { repertoire_id: "A", nodes: [parent] },
    buildCurrentNodeId: parent.id, buildNodeById: new Map([[parent.id, parent]]), buildPending: [],
  };
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, innerHTML: "", classList: { toggle: vi.fn() }, setAttribute: vi.fn(),
    });
    return elements.get(id);
  };
  const board = {
    fen: FEN, legalMoves: localBoardInfo(FEN).legal_moves,
    setPosition(next) { Object.assign(this, next); },
  };
  const common = {
    appState, boards: { build: board }, document: { getElementById }, localBoardInfo,
    takeBuildPreview: vi.fn(), renderBuildRepHeader: vi.fn(), renderBuilderTree: vi.fn(), syncViewHeads: vi.fn(),
    switchView: (name) => { appState.currentView = name; },
  };
  const loading = compile("function setBuildLoading(", common);
  const requests = new Map();
  const hydrateBuild = vi.fn(async (payload) => {
    appState.build = payload;
    board.setPosition({ fen: FEN, legalMoves: localBoardInfo(FEN).legal_moves });
  });
  const deps = {
    ...common, setBuildLoading: loading, hardFlushBuild: vi.fn(async () => {}),
    api: vi.fn((path) => {
      const id = new URL(path, "http://test").searchParams.get("repertoire_id");
      const request = deferred(); requests.set(id, request); return request.promise;
    }),
    hydrateBuild, setStatusError: vi.fn(), syncWorkspaceUrl: vi.fn(), updateBuildReadOnlyUi: vi.fn(),
  };
  // Keep the real request sequence in one closure, like the application.
  const start = source.indexOf("async function editRepertoire(");
  const end = source.indexOf("\n}\n", start) + 2;
  const edit = new Function(...Object.keys(deps),
    `let buildLoadSeq = 0, workspaceNavigationSeq = 0, workspaceUrlReady = true, navigatedDuringBoot = false;
      ${source.slice(start, end)}; return editRepertoire;`)(...Object.values(deps));
  const optimisticBoardMove = vi.fn();
  const move = compile("async function onBuildBoardMove(", {
    ...common, optimisticBoardMove, isBuildReadOnly: () => false,
  });
  return { appState, board, edit, move, requests, hydrateBuild, optimisticBoardMove, deps, getElementById };
}
async function waitForRequest(h, id) {
  await vi.waitFor(() => expect(h.requests.has(id)).toBe(true));
}
const payload = (id) => ({ repertoire_id: id, nodes: [], selected_node_id: null });

describe("repertoire load isolation", () => {
  it("blocks old-tree input until the new tree is hydrated", async () => {
    const h = harness();
    const load = h.edit("B");
    await waitForRequest(h, "B");
    expect(h.appState.currentView).toBe("build");
    expect(h.getElementById("view-build").inert).toBe(true);
    expect(h.board.legalMoves).toEqual([]);
    await h.move("e2e4");
    expect(h.optimisticBoardMove).not.toHaveBeenCalled();
    expect(h.appState.buildPending).toEqual([]);
    h.requests.get("B").resolve(payload("B"));
    await load;
    expect(h.appState.build.repertoire_id).toBe("B");
    expect(h.appState.buildLoading).toBe(false);
    expect(h.getElementById("view-build").inert).toBe(false);
    expect(h.board.legalMoves).toContain("e2e4");
  });

  it("restores the old board after a failed load", async () => {
    const h = harness();
    const load = h.edit("B");
    await waitForRequest(h, "B");
    h.requests.get("B").reject(new Error("offline"));
    await load;
    expect(h.appState.build.repertoire_id).toBe("A");
    expect(h.appState.buildLoading).toBe(false);
    expect(h.board.legalMoves).toContain("e2e4");
    expect(h.deps.setStatusError).toHaveBeenCalledWith("offline");
  });

  it("a superseded response cannot hydrate or unlock the newer load", async () => {
    const h = harness();
    const first = h.edit("B"); await waitForRequest(h, "B");
    const second = h.edit("C"); await waitForRequest(h, "C");
    h.requests.get("B").resolve(payload("B")); await first;
    expect(h.hydrateBuild).not.toHaveBeenCalled();
    expect(h.appState.buildLoading).toBe(true);
    h.requests.get("C").resolve(payload("C")); await second;
    expect(h.appState.build.repertoire_id).toBe("C");
  });

  it("does not navigate back when the user leaves during loading", async () => {
    const h = harness();
    const load = h.edit("B"); await waitForRequest(h, "B");
    h.appState.currentView = "teams";
    h.requests.get("B").resolve(payload("B")); await load;
    expect(h.appState.currentView).toBe("teams");
    expect(h.appState.buildLoading).toBe(false);
  });
});
