import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// Finishing a Train session refreshes the open repertoire's tree, because spaced
// repetition moved its moves from "to train" to learned. That refresh used to
// hand hydrateBuild the repertoire's ID instead of the /api/build/load payload,
// so `appState.build` became a string and the next paint of the Repertoire head
// threw "Cannot read properties of undefined (reading 'filter')" — the error the
// user saw the instant training finished.
//
// These tests run the real functions from source (app.js, build-entry.js,
// controllers/build-session.js), so they exercise the completion call path and
// its guards rather than a restatement of them.

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const entrySource = readFileSync(new URL("./build-entry.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const sessionSource = readFileSync(new URL("./controllers/build-session.js", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

function extract(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`function not found: ${marker}`);
  const end = source.indexOf("\n}\n", start) + 2;
  // `export` is module syntax; these bodies are compiled as plain functions.
  return source.slice(start, end).replace(/^export\s+/, "");
}

function buildReload(deps) {
  return new Function(
    ...Object.keys(deps),
    `${extract(entrySource, "export async function reloadOpenBuildTree(")} return reloadOpenBuildTree;`,
  )(...Object.values(deps));
}

function buildRefresh(deps) {
  return new Function(
    ...Object.keys(deps),
    `${extract(appSource, "async function refreshRepertoireHead(")} return refreshRepertoireHead;`,
  )(...Object.values(deps));
}

// A live Build session object: the refresh only runs when the Repertoire view is
// actually open (there is no tree to re-read otherwise).
function harness(overrides = {}) {
  // Take the caller's state object as-is when given one: a copy would hide the
  // in-flight mutation these tests are about.
  const appState = overrides.appState || {
    signedIn: true,
    ownerGeneration: 1,
    build: { repertoire_id: "rep-1", name: "Caro-Kann", color: "black", revision: 3, nodes: [{ id: "n1" }] },
    buildCurrentNodeId: "n1",
    repertoireList: [],
  };
  appState.signedIn ??= true;
  appState.ownerGeneration ??= 1;
  let currentOwner = overrides.owner || "user-1";
  const currentOwnerId = () => currentOwner;
  const payload = overrides.payload || { repertoire_id: "rep-1", nodes: [{ id: "n1" }, { id: "n2" }], revision: 4 };
  const api = overrides.api || vi.fn(async () => payload);
  const hydrateBuild = overrides.hydrateBuild || vi.fn(async () => {});
  const hooks = { build: { session: { hydrateBuild } } };
  const loadDashboardRepertoires = vi.fn(async () => true);
  const libraryEntry = { dashboardView: { loadDashboardRepertoires } };
  const renderBuildRepHeader = vi.fn();
  const syncViewHeads = vi.fn();

  const reloadOpenBuildTree = buildReload({ appState, api, currentOwnerId, hooks });
  const refreshRepertoireHead = buildRefresh({
    appState, api, libraryEntry, reloadOpenBuildTree, renderBuildRepHeader, syncViewHeads,
  });

  return {
    appState, api, hydrateBuild, hooks, loadDashboardRepertoires, renderBuildRepHeader, syncViewHeads,
    reloadOpenBuildTree, refreshRepertoireHead,
    // Simulate the account changing under an in-flight read.
    switchOwner: (id) => { currentOwner = id; },
  };
}

// A promise the test settles by hand, so the code under test is genuinely
// suspended mid-request when the world changes.
function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

describe("Train completion refreshes the open repertoire tree", () => {
  it("loads the tree and hands hydrateBuild the payload, never the id", async () => {
    const h = harness();
    await h.refreshRepertoireHead();
    expect(h.api).toHaveBeenCalledWith("/api/build/load?repertoire_id=rep-1");
    expect(h.hydrateBuild).toHaveBeenCalledTimes(1);
    const [payload, selection] = h.hydrateBuild.mock.calls[0];
    expect(typeof payload).toBe("object");
    expect(payload.repertoire_id).toBe("rep-1");
    expect(Array.isArray(payload.nodes)).toBe(true);
    expect(selection).toBe("n1"); // the open node survives the re-read
    expect(h.loadDashboardRepertoires).toHaveBeenCalledTimes(1);
    expect(h.renderBuildRepHeader).toHaveBeenCalledTimes(1);
    expect(h.syncViewHeads).toHaveBeenCalledTimes(1);
  });

  it("leaves the tree alone when no repertoire is open", async () => {
    const h = harness({ appState: {
      build: null, buildCurrentNodeId: null, ownerGeneration: 1,
    } });
    await h.refreshRepertoireHead();
    expect(h.api).not.toHaveBeenCalled();
    expect(h.hydrateBuild).not.toHaveBeenCalled();
    // The listing still refreshes: the Library rows went stale either way.
    expect(h.loadDashboardRepertoires).toHaveBeenCalledTimes(1);
  });

  it("keeps the current tree when the re-read fails", async () => {
    const h = harness({ api: vi.fn(async () => { throw new Error("offline"); }) });
    const before = h.appState.build;
    await expect(h.refreshRepertoireHead()).resolves.toBeUndefined();
    expect(h.hydrateBuild).not.toHaveBeenCalled();
    expect(h.appState.build).toBe(before);
    expect(h.renderBuildRepHeader).toHaveBeenCalledTimes(1);
  });

  it("drops a re-read that lands after another repertoire was opened", async () => {
    const appState = {
      signedIn: true, ownerGeneration: 1,
      build: { repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] }, buildCurrentNodeId: "n1",
    };
    const api = vi.fn(async () => {
      // The user opened a different repertoire while this read was in flight.
      appState.build = { repertoire_id: "rep-2", revision: 8, nodes: [{ id: "m1" }] };
      return { repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] };
    });
    const h = harness({ appState, api });
    await h.refreshRepertoireHead();
    expect(h.hydrateBuild).not.toHaveBeenCalled();
    expect(h.appState.build.repertoire_id).toBe("rep-2");
  });

  it("lets hydration find the surviving ancestor when the open node is gone", async () => {
    const h = harness({ appState: {
      ownerGeneration: 1,
      build: { repertoire_id: "rep-1", name: "Caro-Kann", color: "black", revision: 3, nodes: [{ id: "n1" }] },
      buildCurrentNodeId: "deleted-node",
    } });
    await h.refreshRepertoireHead();
    expect(h.hydrateBuild.mock.calls[0][1]).toBe("deleted-node");
  });

  it("does nothing when the Repertoire view is not loaded (no tree on screen)", async () => {
    const h = harness();
    h.hooks.build = null;
    await h.refreshRepertoireHead();
    expect(h.api).not.toHaveBeenCalled();
    expect(h.hydrateBuild).not.toHaveBeenCalled();
    expect(h.loadDashboardRepertoires).toHaveBeenCalledTimes(1);
  });

  // The read is a window: anything that moves the tree while it is open makes the
  // payload older than what is on screen, so it must be dropped, not adopted.
  it("drops a read that lands after a queued edit was acknowledged mid-flight", async () => {
    const appState = {
      signedIn: true, ownerGeneration: 1, buildCurrentNodeId: "n1",
      build: { repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] },
    };
    const gate = deferred();
    const api = vi.fn(() => gate.promise);
    const h = harness({ appState, api });
    const pending = h.refreshRepertoireHead();
    // A flush acknowledged an edit: the tree is re-hydrated and the revision moves.
    appState.build = { repertoire_id: "rep-1", revision: 4, nodes: [{ id: "n1" }, { id: "new" }] };
    gate.release({ repertoire_id: "rep-1", revision: 4, nodes: [{ id: "n1" }] });
    await pending;
    expect(h.hydrateBuild).not.toHaveBeenCalled();
    expect(h.appState.build.nodes.map((n) => n.id)).toEqual(["n1", "new"]);
  });

  it("drops a read that lands after a confirmed edit moved the same tree's revision", async () => {
    const appState = {
      signedIn: true, ownerGeneration: 1, buildCurrentNodeId: "n1",
      build: { repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] },
    };
    const gate = deferred();
    const api = vi.fn(() => gate.promise);
    const h = harness({ appState, api });
    const pending = h.refreshRepertoireHead();
    // Same object, newer revision (an annotation/rename landed in place).
    appState.build.revision = 4;
    gate.release({ repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] });
    await pending;
    expect(h.hydrateBuild).not.toHaveBeenCalled();
    expect(h.appState.build.revision).toBe(4);
  });

  it("drops a read that lands after the account changed", async () => {
    const appState = {
      signedIn: true, ownerGeneration: 1, buildCurrentNodeId: "n1",
      build: { repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] },
    };
    const gate = deferred();
    const api = vi.fn(() => gate.promise);
    const h = harness({ appState, api });
    const pending = h.refreshRepertoireHead();
    h.switchOwner("user-2");
    gate.release({ repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] });
    await pending;
    expect(h.hydrateBuild).not.toHaveBeenCalled();
  });

  it("drops a read that lands after the workspace generation changed", async () => {
    const appState = {
      signedIn: true, ownerGeneration: 1, buildCurrentNodeId: "n1",
      build: { repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] },
    };
    const gate = deferred();
    const api = vi.fn(() => gate.promise);
    const h = harness({ appState, api });
    const pending = h.refreshRepertoireHead();
    appState.ownerGeneration = 2; // sign-out / sign-in of the same owner id
    gate.release({ repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] });
    await pending;
    expect(h.hydrateBuild).not.toHaveBeenCalled();
  });

  it("drops a read that lands after the user signed out", async () => {
    const appState = {
      signedIn: true, ownerGeneration: 1, buildCurrentNodeId: "n1",
      build: { repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] },
    };
    const gate = deferred();
    const api = vi.fn(() => gate.promise);
    const h = harness({ appState, api });
    const pending = h.refreshRepertoireHead();
    appState.signedIn = false;
    gate.release({ repertoire_id: "rep-1", revision: 3, nodes: [{ id: "n1" }] });
    await pending;
    expect(h.hydrateBuild).not.toHaveBeenCalled();
  });
});

// The guard that makes the original bug impossible to reintroduce silently:
// hydrateBuild refuses anything that is not a /api/build/load payload, instead of
// writing a string into appState.build.
describe("hydrateBuild payload contract", () => {
  function hydrate(appState) {
    return new Function(
      "appState", "coverageView", "invalidateBook", "boards",
      "renderBuildRepHeader", "selectBuildNode", "reapplyPendingBuildNodes",
      "reapplyPendingBuildDeletes", "hasPendingBuildOpsFor", "setBuildSync",
      "scheduleBuildFlush", "renderBuildSync", "syncWorkspaceUrl",
      `${extract(sessionSource, "async function hydrateBuild(")} return hydrateBuild;`,
    )(
      appState, null, () => {}, {}, () => {}, async () => {}, () => {}, () => {},
      () => false, () => {}, () => {}, () => {}, () => {},
    );
  }

  it("refuses anything that is not a /api/build/load payload", async () => {
    const appState = {
      build: { repertoire_id: "rep-1", nodes: [] }, buildNodeById: new Map(),
      buildPending: [], buildPendingDeletes: [], buildIdMap: {},
    };
    const hydrateBuild = hydrate(appState);
    const before = appState.build;
    for (const bad of ["rep-1", null, undefined, 42, {}, { repertoire_id: "rep-1" }, { nodes: [] }]) {
      await expect(hydrateBuild(bad)).rejects.toThrow(/api\/build\/load payload/);
      // A refused call must not have touched the open tree.
      expect(appState.build).toBe(before);
    }
  });
});
