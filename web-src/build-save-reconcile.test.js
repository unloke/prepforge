import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { createSyncController } from "./controllers/sync.js";
import { loadDurableOutbox } from "./sync-queue.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
function compile(name, deps) {
  const at = source.indexOf(`function ${name}(`);
  const start = source.slice(at - 6, at) === "async " ? at - 6 : at;
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}
const node = (id, parent_id, depth) => ({ id, parent_id, depth, fen: id, san: id, uci: id });
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const locks = new Map();
  vi.stubGlobal("localStorage", { getItem: k => locks.get(k),
    setItem: (k, v) => locks.set(k, v), removeItem: k => locks.delete(k) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function harness() {
  const root = node("root", null, 0), saved = node("saved", "root", 1);
  const pending = node("tmp-next", "saved", 2);
  const appState = {
    build: { repertoire_id: "r", nodes: [root, saved, pending] },
    buildNodeById: new Map([root, saved, pending].map(n => [n.id, n])),
    buildCurrentNodeId: pending.id, buildIdMap: {},
    buildPending: [{ tempId: pending.id, parentRef: saved.id, node: pending, repertoire_id: "r" }],
    buildPendingDeletes: [], buildUndoDeletes: new Set(),
  };
  const positions = [];
  const deps = {
    appState, coverageView: null, invalidateBook: vi.fn(), renderBuildRepHeader: vi.fn(),
    boards: { build: { setPosition: vi.fn(p => positions.push(p.fen)), setAnnotations: vi.fn() } },
    buildOpMatchesRepertoire: (op, id) => op.repertoire_id === id,
    resolveBuildId: ref => { const id = ref && typeof ref === "object" ? ref.id : ref; return appState.buildIdMap[id] || id; },
    hasPendingBuildOpsFor: () => appState.buildPending.length > 0,
    setBuildSync: vi.fn(), scheduleBuildFlush: vi.fn(), renderBuildSync: vi.fn(), syncWorkspaceUrl: vi.fn(),
    boardInfo: vi.fn(async () => ({ legal_moves: [] })),
    document: { getElementById: () => ({}) }, buildView: { updateBuildTreeSelection: vi.fn() },
    renderBuilderTree: vi.fn(), engineWidget: { onBoardChanged: vi.fn() }, scheduleExplorerRefresh: vi.fn(),
  };
  deps.pruneLocalBuildSubtree = compile("pruneLocalBuildSubtree", deps);
  deps.reapplyPendingBuildNodes = compile("reapplyPendingBuildNodes", deps);
  deps.reapplyPendingBuildDeletes = compile("reapplyPendingBuildDeletes", deps);
  deps.selectBuildNode = compile("selectBuildNode", deps);
  return { appState, deps, positions, hydrate: compile("hydrateBuild", deps),
    payload: { repertoire_id: "r", nodes: [root, saved] } };
}

describe("repertoire save reconciliation", () => {
  it("keeps the pending selection throughout the save response, without an ancestor repaint", async () => {
    const h = harness();
    await h.hydrate(h.payload, "tmp-next");
    expect(h.positions).toEqual(["tmp-next"]);
    expect(h.appState.buildCurrentNodeId).toBe("tmp-next");
    expect(h.deps.engineWidget.onBoardChanged).toHaveBeenCalledOnce();
  });

  it("chooses the nearest surviving ancestor when the selected line was removed", async () => {
    const h = harness();
    h.appState.buildPending = [];
    await h.hydrate(h.payload, "tmp-next");
    expect(h.positions).toEqual(["saved"]);
  });

  it("prunes pending deletions before painting the selected position", async () => {
    const h = harness();
    h.appState.buildPending = [];
    h.appState.buildPendingDeletes = [{ id: "saved", repertoire_id: "r" }];
    await h.hydrate(h.payload, "saved");
    expect(h.positions).toEqual(["root"]);
  });

  it("does not let delayed board data repaint an older selection", async () => {
    const h = harness();
    let finish;
    h.deps.boardInfo.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = h.deps.selectBuildNode("saved");
    await h.deps.selectBuildNode("tmp-next");
    finish({ legal_moves: [] });
    await old;
    expect(h.positions).toEqual(["tmp-next"]);
  });

  it("translates an acknowledged selection and its branch choice in one paint", async () => {
    const h = harness();
    h.appState.buildCurrentNodeId = "tmp-saved";
    h.appState.buildBranchChoiceId = "tmp-next";
    h.appState.buildIdMap["tmp-saved"] = "saved";
    await h.hydrate(h.payload, "tmp-saved");
    expect(h.positions).toEqual(["saved"]);
    expect(h.appState.buildBranchChoiceId).toBe("tmp-next");
  });

  it("queues the real parent if it was acknowledged during local move calculation", () => {
    const h = harness();
    const queue = compile("queueBuildAdd", h.deps);
    h.appState.buildIdMap["tmp-parent"] = "saved";
    queue(node("tmp-child", "tmp-parent", 2));
    expect(h.appState.buildPending.at(-1).parentRef).toBe("saved");
  });
});

function syncHarness() {
  const h = harness();
  Object.assign(h.appState, { ownerGeneration: 1, trainSync: { pending: [] }, buildPending: [] });
  const deps = { ...h.deps, currentOwnerId: () => "owner", captureBuildContext: () => () => true,
    OUTBOX_TAB_ID: "save-test", hydrateBuild: h.hydrate, setStatus: vi.fn(), setStatusError: vi.fn(),
    postJson: vi.fn(), setBuildSync: vi.fn(state => { h.appState.buildSyncState = state; }),
  };
  const controller = createSyncController(deps);
  const queue = compile("queueBuildAdd", deps);
  return { ...h, deps, controller, queue };
}

describe("repertoire durable save", () => {
  it("saves once with three durable writes and restores the acknowledged IDs", async () => {
    const h = syncHarness();
    const writes = vi.spyOn(IDBObjectStore.prototype, "put");
    h.queue(node("tmp-first", "root", 1));
    h.appState.buildCurrentNodeId = "tmp-first";
    h.deps.postJson.mockResolvedValue({ repertoire_id: "r", id_map: { "tmp-first": "first" },
      nodes: [node("root", null, 0), node("first", "root", 1)] });
    h.controller.scheduleBuildFlush();
    expect(await h.controller.flushBuildMoves()).toBe(true);
    expect(h.deps.postJson).toHaveBeenCalledOnce();
    expect(writes).toHaveBeenCalledTimes(3);
    expect(h.appState.buildSyncState).toBe("saved");
    const restored = await loadDurableOutbox("owner");
    expect(restored.build.pending).toEqual([]);
    expect(restored.build.idMap["tmp-first"]).toBe("first");
    expect(restored.settled.build).toContain("tmp-first");
  });

  it("keeps a move played during the request selected and queued with its real parent", async () => {
    const h = syncHarness();
    let finish;
    h.deps.postJson.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    h.queue(node("tmp-first", "root", 1));
    h.appState.buildCurrentNodeId = "tmp-first";
    const saving = h.controller.flushBuildMoves();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.queue(node("tmp-second", "tmp-first", 2));
    h.appState.buildCurrentNodeId = "tmp-second";
    h.controller.scheduleBuildFlush();
    finish({ repertoire_id: "r", id_map: { "tmp-first": "first" },
      nodes: [node("root", null, 0), node("first", "root", 1)] });
    expect(await saving).toBe(true);
    clearTimeout(h.appState.buildFlushTimer);
    expect(h.positions).toEqual(["tmp-second"]);
    expect(h.appState.buildPending).toMatchObject([{ tempId: "tmp-second", parentRef: "first" }]);
    expect(h.appState.buildSyncState).toBe("dirty");
    expect(h.deps.setStatusError).not.toHaveBeenCalled();
    expect(h.deps.engineWidget.onBoardChanged).toHaveBeenCalledOnce();
  });
});
