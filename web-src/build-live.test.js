import { describe, expect, it, vi } from "vitest";
import {
  LIVE_IDLE_POLL_MS, LIVE_POLL_MS, announceBuildWrite, applyBuildChanges, createBuildLive, remoteChangeNotice,
} from "./build-live.js";

const node = (id, parent_id, extra = {}) => ({ id, parent_id, uci: id, is_mainline: false, comment: "", ...extra });

function tree() {
  return {
    repertoire_id: "r", revision: 5, name: "KP", nodes_total: 5, writable: true,
    nodes: [node("root", null), node("e4", "root"), node("e5", "e4"), node("nf3", "e5"), node("d4", "root")],
  };
}

describe("applyBuildChanges", () => {
  it("upserts written nodes in place, appends new ones and drops removed subtrees", () => {
    const build = tree();
    const { payload, selection } = applyBuildChanges(build, {
      revision: 8, name: "Kings pawn", nodes_total: 4,
      nodes: [node("e4", "root", { comment: "main" }), node("c5", "e4")],
      removed: ["e5"],
    }, "nf3");
    expect(payload.nodes.map((n) => n.id)).toEqual(["root", "e4", "d4", "c5"]);
    expect(payload.nodes[1].comment).toBe("main");
    expect(payload).toMatchObject({ revision: 8, name: "Kings pawn", nodes_total: 4, writable: true });
    // nf3 went with e5 (not listed: reachability decides), so the selection
    // falls back to the nearest surviving ancestor.
    expect(selection).toBe("e4");
    expect(build.revision).toBe(5); // pure
    expect(build.nodes).toHaveLength(5);
  });

  it("leaves this tab's unsynced moves to hydrate and keeps a surviving selection", () => {
    const build = tree();
    build.nodes.push(node("tmp-x-1", "d4"));
    const { payload, selection } = applyBuildChanges(build, { revision: 6, nodes: [], removed: [] }, "tmp-x-1");
    expect(payload.nodes.map((n) => n.id)).not.toContain("tmp-x-1");
    expect(selection).toBe("d4");
    expect(applyBuildChanges(build, { revision: 6 }, "e5").selection).toBe("e5");
  });

  it("is idempotent: the same delta applied twice gives the same tree", () => {
    const delta = { revision: 7, nodes: [node("c4", "root")], removed: ["d4"] };
    const once = applyBuildChanges(tree(), delta, "root").payload;
    const twice = applyBuildChanges(once, delta, "root").payload;
    expect(twice.nodes).toEqual(once.nodes);
  });
});

describe("remoteChangeNotice", () => {
  const ops = (...list) => ({ ops: list });
  it("stays quiet for this tab's own writes", () => {
    expect(remoteChangeNotice(ops({ client_id: "me", kind: "add_moves" }), { tabId: "me" })).toBeNull();
  });
  it("names what happened, most important first", () => {
    const ctx = { tabId: "me", name: "Kings pawn" };
    expect(remoteChangeNotice(ops({ client_id: "b", actor_user_id: "u1", kind: "add_moves" }), ctx))
      .toBe("Updated elsewhere");
    expect(remoteChangeNotice(ops({ client_id: "b", actor_user_id: "u1", kind: "rename" }), ctx))
      .toBe("Renamed to Kings pawn elsewhere");
    expect(remoteChangeNotice(ops({ client_id: "b", actor_user_id: "u2", kind: "delete_nodes" }),
      { ...ctx, selectionLost: true })).toBe("Line deleted elsewhere");
  });
});

function harness({ changes = { revision: 5 }, open = true, defaultOpen = false } = {}) {
  const pending = [];
  const timers = {
    setTimeout: vi.fn((fn, ms) => { pending.push({ fn, ms }); return pending.length; }),
    clearTimeout: vi.fn(),
  };
  const appState = { build: tree(), buildCurrentNodeId: "nf3", buildNodeById: new Map(), accountUserId: "u1" };
  const deps = {
    appState, timers, doc: { hidden: false, addEventListener() {}, removeEventListener() {} },
    api: vi.fn(async () => (typeof changes === "function" ? changes() : changes)),
    hydrate: vi.fn(async (payload) => {
      appState.build = payload;
      appState.buildNodeById = new Map(payload.nodes.map((n) => [n.id, n]));
    }),
    select: vi.fn(async (id) => { appState.buildCurrentNodeId = id; }),
    reload: vi.fn(async () => true),
    isOpen: vi.fn(() => open),
    notify: vi.fn(),
    tabId: "me",
    now: () => 0,
  };
  if (defaultOpen) {
    delete deps.isOpen;
    deps.activeView = () => "build";
    appState.signedIn = true;
  }
  const live = createBuildLive(deps);
  return { live, deps, appState, pending };
}

describe("createBuildLive", () => {
  it("follows a repertoire shared to this account at any role, but not a public link", async () => {
    for (const shared of [{ role: "edit", writable: true }, { role: "view", writable: false }]) {
      const h = harness({ defaultOpen: true });
      Object.assign(h.appState.build, shared, { shared: true });
      await h.live.tick();
      expect(h.deps.api).toHaveBeenCalledWith("/api/build/changes?repertoire_id=r&since=5");
    }
    const link = harness({ defaultOpen: true });
    link.appState.sharedToken = "tok";
    await link.live.tick();
    expect(link.deps.api).not.toHaveBeenCalled();
  });

  it("asks for changes since the open revision and does nothing when there are none", async () => {
    const h = harness();
    await h.live.tick();
    expect(h.deps.api).toHaveBeenCalledWith("/api/build/changes?repertoire_id=r&since=5");
    expect(h.deps.hydrate).not.toHaveBeenCalled();
    expect(h.pending.at(-1).ms).toBe(LIVE_POLL_MS);
  });

  it("applies another device's delta and says so once", async () => {
    const h = harness({ changes: { revision: 6, nodes: [], removed: ["e5"],
      ops: [{ revision: 6, kind: "delete_nodes", client_id: "other", actor_user_id: "u1" }] } });
    await h.live.tick();
    expect(h.deps.hydrate).toHaveBeenCalledTimes(1);
    const [payload, selection] = h.deps.hydrate.mock.calls[0];
    expect(payload.revision).toBe(6);
    expect(selection).toBe("e4");
    expect(h.deps.notify).toHaveBeenCalledWith("Line deleted elsewhere");
  });

  it("re-selects an unsynced move that hydrate put back", async () => {
    const h = harness({ changes: { revision: 6, nodes: [], removed: [], ops: [] } });
    h.appState.build.nodes.push(node("tmp-me-1", "d4"));
    h.appState.buildCurrentNodeId = "tmp-me-1";
    h.deps.hydrate.mockImplementation(async (payload) => {
      h.appState.build = payload;
      h.appState.buildNodeById = new Map([...payload.nodes, node("tmp-me-1", "d4")].map((n) => [n.id, n]));
    });
    await h.live.tick();
    expect(h.deps.hydrate.mock.calls[0][1]).toBe("d4");
    expect(h.deps.select).toHaveBeenCalledWith("tmp-me-1");
    expect(h.deps.notify).not.toHaveBeenCalled();
  });

  it("drops a delta when this tab wrote or switched trees while it was in flight", async () => {
    const h = harness();
    h.deps.api.mockImplementation(async () => {
      h.appState.build.revision = 6; // our own write landed meanwhile
      return { revision: 7, nodes: [], removed: [], ops: [] };
    });
    await h.live.tick();
    expect(h.deps.hydrate).not.toHaveBeenCalled();
  });

  it("waits while a save is in flight instead of racing it", async () => {
    const h = harness();
    h.appState.buildFlushing = Promise.resolve();
    await h.live.tick();
    expect(h.deps.api).not.toHaveBeenCalled();
    expect(h.pending.at(-1).ms).toBeLessThan(LIVE_POLL_MS);
  });

  it("reloads the tree when the log no longer reaches back", async () => {
    const h = harness({ changes: { revision: 900, reset: true } });
    await h.live.tick();
    expect(h.deps.reload).toHaveBeenCalledTimes(1);
    expect(h.deps.hydrate).not.toHaveBeenCalled();
  });

  it("reloads when the caller's role changed, even with no new writes", async () => {
    const h = harness({ changes: { revision: 0, role: "edit" } });
    h.appState.build.role = "view";
    h.appState.build.revision = 0;
    await h.live.tick();
    expect(h.deps.reload).toHaveBeenCalledTimes(1);
    const same = harness({ changes: { revision: 0, role: "view" } });
    same.appState.build.role = "view";
    same.appState.build.revision = 0;
    await same.live.tick();
    expect(same.deps.reload).not.toHaveBeenCalled();
  });

  it("does not poll while hidden or away from Build, and slows down when idle", async () => {
    const hidden = harness();
    hidden.deps.doc.hidden = true;
    await hidden.live.tick();
    const away = harness({ open: false });
    await away.live.tick();
    expect(hidden.deps.api).not.toHaveBeenCalled();
    expect(away.deps.api).not.toHaveBeenCalled();

    let clock = 0;
    const idle = harness();
    idle.deps.now = () => clock;
    const live = createBuildLive({ ...idle.deps, now: () => clock });
    clock = 120000;
    await live.tick();
    expect(idle.pending.at(-1).ms).toBe(LIVE_IDLE_POLL_MS);
  });

  it("this tab's own write checks at once and keeps the fast rate while others are quiet", async () => {
    let clock = 0;
    const h = harness();
    const live = createBuildLive({ ...h.deps, now: () => clock });
    live.start();
    clock = 120000;
    announceBuildWrite("r");
    expect(h.pending.at(-1).ms).toBe(0);
    await live.tick();
    expect(h.pending.at(-1).ms).toBe(LIVE_POLL_MS);
    live.stop();
  });

  it("checks at once when another tab of this browser announces a write to the open tree", () => {
    const h = harness();
    h.live.onMessage({ data: { repertoire_id: "other" } });
    expect(h.pending).toHaveLength(0);
    h.live.onMessage({ data: { repertoire_id: "r" } });
    expect(h.pending.at(-1).ms).toBe(0);
  });
});
