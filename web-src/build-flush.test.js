// A Build autosave asks for the changes after its tree's revision and patches
// them in, instead of downloading and re-rendering the whole tree.
import { beforeEach, describe, expect, it, vi } from "vitest";

const reloads = [];
vi.mock("./build-entry.js", () => ({ reloadOpenBuildTree: vi.fn(async () => { reloads.push(1); return true; }) }));
vi.mock("./core/api.js", () => ({ postJson: vi.fn() }));

import { NO_TREE_SINCE, applyFlushReply, flushSince, postBuildAdds } from "./build-flush.js";
import { MAX_ADD_MOVES_BATCH } from "./generated/shared-constants.js";
import { buildState } from "./core/state.js";

const tree = () => ({
  repertoire_id: "rep", revision: 7, role: "owner", name: "KP", nodes_total: 3,
  nodes: [
    { id: "root", parent_id: null },
    { id: "e4", parent_id: "root", uci: "e2e4" },
    { id: "tmp-1", parent_id: "e4", uci: "e7e5" },
  ],
});

beforeEach(() => {
  reloads.length = 0;
  buildState.build = tree();
  buildState.buildCurrentNodeId = "tmp-1";
});

describe("flushSince", () => {
  it("is the open tree's revision", () => {
    expect(flushSince("rep")).toBe(7);
  });

  it("asks for no tree for a repertoire this tab is not showing", () => {
    expect(flushSince("other")).toBe(NO_TREE_SINCE);
    buildState.build = { ...tree(), optimistic: true };
    expect(flushSince("rep")).toBe(NO_TREE_SINCE);
    buildState.build = null;
    expect(flushSince("rep")).toBe(NO_TREE_SINCE);
  });
});

describe("postBuildAdds", () => {
  it("sends one request for a batch the server accepts", async () => {
    const post = vi.fn(async () => ({ revision: 8, id_map: { "tmp-1": "e5" }, dropped: [] }));
    const reply = await postBuildAdds("rep", [{ tempId: "tmp-1", parentRef: "e4", uci: "e7e5" }], 7, post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toEqual({ repertoire_id: "rep", since: 7,
      moves: [{ tempId: "tmp-1", parentRef: "e4", uci: "e7e5" }] });
    expect(reply.id_map).toEqual({ "tmp-1": "e5" });
  });

  it("splits a long line into accepted batches, each hanging off the last one's real ids", async () => {
    const count = MAX_ADD_MOVES_BATCH + 20;
    const batch = Array.from({ length: count }, (_, i) => ({
      tempId: `tmp-${i}`, parentRef: i ? `tmp-${i - 1}` : "root", uci: "e2e4",
    }));
    const post = vi.fn(async (_path, body) => ({
      revision: 7 + post.mock.calls.length,
      id_map: Object.fromEntries(body.moves.map((m) => [m.tempId, m.tempId.replace("tmp-", "n")])),
      dropped: post.mock.calls.length === 2 ? ["tmp-x"] : [],
    }));
    const reply = await postBuildAdds("rep", batch, 7, post);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.map((call) => call[1].moves.length)).toEqual([MAX_ADD_MOVES_BATCH, 20]);
    expect(post.mock.calls.every((call) => call[1].since === 7)).toBe(true);
    // The second batch's first move hangs off a node the first batch created.
    expect(post.mock.calls[1][1].moves[0].parentRef).toBe(`n${MAX_ADD_MOVES_BATCH - 1}`);
    expect(Object.keys(reply.id_map)).toHaveLength(count);
    expect(reply.dropped).toEqual(["tmp-x"]);
    expect(reply.revision).toBe(9);
  });
});

describe("applyFlushReply", () => {
  it("patches a delta in and keeps an unsynced selection for hydrate to resolve", async () => {
    const hydrate = vi.fn();
    await applyFlushReply({ revision: 8, role: "owner", nodes: [{ id: "e5", parent_id: "e4", uci: "e7e5" }],
      removed: [], id_map: { "tmp-1": "e5" } }, hydrate);
    const [payload, selection] = hydrate.mock.calls[0];
    expect(payload.revision).toBe(8);
    expect(payload.repertoire_id).toBe("rep");
    expect(payload.nodes.map((node) => node.id)).toEqual(["root", "e4", "e5"]);
    expect(selection).toBe("tmp-1");
  });

  it("re-hydrates a whole payload as before", async () => {
    const hydrate = vi.fn();
    const full = { ...tree(), revision: 8 };
    await applyFlushReply(full, hydrate);
    expect(hydrate).toHaveBeenCalledWith(full, "tmp-1");
  });

  it("re-reads the tree when the log no longer reaches back or the role changed", async () => {
    const hydrate = vi.fn();
    await applyFlushReply({ revision: 120, role: "owner", reset: true }, hydrate);
    await applyFlushReply({ revision: 8, role: "view", nodes: [], removed: [] }, hydrate);
    expect(hydrate).not.toHaveBeenCalled();
    expect(reloads).toHaveLength(2);
  });
});
