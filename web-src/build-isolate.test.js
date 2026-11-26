// One illegal move in an autosave batch used to cost one request per queued
// move: the whole batch came back 400 and every op was resent alone to find the
// bad one, at a rate limit of 30 requests a minute. The server now names the
// rejected move, so the flush drops it (and the moves played after it) and
// resends the rest in one batch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = { reloads: 0 };
vi.mock("./core/api.js", () => ({ postJson: vi.fn() }));
vi.mock("./build-entry.js", () => ({
  resolveBuildId: (id) => (id && id.id) || id,
  reloadOpenBuildTree: vi.fn(async () => { calls.reloads += 1; }),
}));

import { postJson } from "./core/api.js";
import { isolateRejectedBuildOps } from "./build-isolate.js";

beforeEach(() => {
  calls.reloads = 0;
  postJson.mockReset();
});

function rejectedMove(tempId) {
  const error = new Error("illegal move e7e5");
  error.status = 400;
  error.detail = { error: "move_rejected", temp_id: tempId, message: "illegal move e7e5" };
  return error;
}

// A server that rejects any batch holding the bad move, naming it.
function server(bad) {
  return postJson.mockImplementation(async (path, body) => {
    const hit = (body.moves || []).find((m) => m.tempId === bad);
    if (hit) throw rejectedMove(bad);
    return { revision: 9, id_map: Object.fromEntries((body.moves || []).map((m) => [m.tempId, `n-${m.tempId}`])), dropped: [] };
  });
}

describe("one rejected move in a Build flush", () => {
  it("costs one more request, not one per queued move", async () => {
    const batch = Array.from({ length: 40 }, (_, i) => ({ tempId: `tmp-${i}`, parentRef: "root", uci: "g1f3" }));
    // tmp-41 was played after the bad move: it can't land without it.
    batch.push({ tempId: "tmp-41", parentRef: "tmp-3", uci: "b8c6" });
    server("tmp-3");
    const { rejected, settled, idMap } = await isolateRejectedBuildOps(batch, [], "rep", rejectedMove("tmp-3"), 7);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(postJson.mock.calls[0][1]).toMatchObject({ repertoire_id: "rep", since: 7 });
    expect(postJson.mock.calls[0][1].moves).toHaveLength(39);
    expect(rejected.map((entry) => entry.tempId)).toEqual(["tmp-3", "tmp-41"]);
    expect(settled.build).toHaveLength(41);
    expect(idMap["tmp-0"]).toBe("n-tmp-0");
    expect(idMap["tmp-3"]).toBeUndefined();
  });

  it("still finds the bad move one at a time when the server does not name it", async () => {
    const batch = [{ tempId: "tmp-a", parentRef: "root", uci: "g1f3" }, { tempId: "tmp-b", parentRef: "root", uci: "zz" }];
    const unnamed = Object.assign(new Error("invalid UCI move: zz"), { status: 400, detail: "invalid UCI move: zz" });
    postJson.mockImplementation(async (_path, body) => {
      if (body.moves[0].uci === "zz") throw unnamed;
      return { id_map: { "tmp-a": "n-a" } };
    });
    const { rejected } = await isolateRejectedBuildOps(batch, [], "rep", unnamed, 7);
    expect(postJson).toHaveBeenCalledTimes(2);
    expect(rejected.map((entry) => entry.tempId)).toEqual(["tmp-b"]);
  });

  it("rejects every queued edit at once when edit rights were taken away", async () => {
    const denied = Object.assign(new Error("You can't edit this repertoire."),
      { status: 403, detail: "You can't edit this repertoire." });
    const batch = [{ tempId: "tmp-a", parentRef: "root", uci: "g1f3" }, { tempId: "tmp-b", parentRef: "tmp-a", uci: "g8f6" }];
    const deletes = [{ id: "n-1" }, { id: "n-2" }];
    const { rejected, settled } = await isolateRejectedBuildOps(batch, deletes, "rep", denied, 7);
    expect(postJson).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(4);
    expect(settled.build).toEqual(["tmp-a", "tmp-b"]);
    expect(settled.deletes).toEqual(["n-1", "n-2"]);
    expect(calls.reloads).toBe(1);
  });

  it("sends queued adds as one batch when only a delete was refused", async () => {
    const refused = Object.assign(new Error("bad id"), { status: 400, detail: "bad id" });
    postJson.mockImplementation(async (path) => {
      if (path === "/api/build/delete-nodes") throw refused;
      return { revision: 9, id_map: { "tmp-a": "n-a", "tmp-b": "n-b" } };
    });
    const batch = [{ tempId: "tmp-a", parentRef: "root", uci: "g1f3" }, { tempId: "tmp-b", parentRef: "root", uci: "e2e4" }];
    const { rejected, idMap } = await isolateRejectedBuildOps(batch, [{ id: "n-1" }], "rep", refused, 7);
    expect(postJson.mock.calls.map((call) => call[0])).toEqual(["/api/build/delete-nodes", "/api/build/add-moves"]);
    expect(rejected.map((entry) => entry.kind)).toEqual(["delete"]);
    expect(idMap).toEqual({ "tmp-a": "n-a", "tmp-b": "n-b" });
  });
});
