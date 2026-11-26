// Build's tree writes keep their own rules (build-write.js): one at a time, the
// open tree advancing only past its own write, every write announced. The
// generic request helpers in core/api.js carry none of this.
import { beforeEach, describe, expect, it, vi } from "vitest";

let owner = "owner";
vi.mock("./core/api.js", () => ({ postJson: vi.fn(), currentOwnerId: () => owner }));
vi.mock("./build-live.js", () => ({ announceBuildWrite: vi.fn() }));

import { postJson } from "./core/api.js";
import { announceBuildWrite } from "./build-live.js";
import { appState, buildState } from "./core/state.js";
import { postBuildWrite } from "./build-write.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  owner = "owner";
  postJson.mockReset();
  announceBuildWrite.mockReset();
  buildState.build = { repertoire_id: "r", revision: 4 };
  buildState.buildMutationSaving = null;
});

describe("postBuildWrite", () => {
  it("sends each write only after the one before it, without a base revision", async () => {
    const first = deferred();
    postJson.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ revision: 6 });
    const a = postBuildWrite("/api/build/annotations", { repertoire_id: "r" });
    const b = postBuildWrite("/api/build/add-moves", { repertoire_id: "r" });
    await Promise.resolve();
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(postJson.mock.calls[0][1]).not.toHaveProperty("base_revision");
    first.resolve({ revision: 5 });
    await Promise.all([a, b]);
    expect(postJson).toHaveBeenCalledTimes(2);
    expect(buildState.build.revision).toBe(6);
    expect(announceBuildWrite).toHaveBeenCalledTimes(2);
    expect(buildState.buildMutationSaving).toBeNull();
  });

  it("leaves a revision gap for the change feed to fill", async () => {
    postJson.mockResolvedValueOnce({ revision: 7 }); // someone else wrote 5 and 6
    await postBuildWrite("/api/build/action", { repertoire_id: "r" });
    expect(buildState.build.revision).toBe(4);
    expect(announceBuildWrite).toHaveBeenCalledWith("r");
  });

  it("does not move a tree the user switched away from", async () => {
    const reply = deferred();
    postJson.mockReturnValueOnce(reply.promise);
    const old = buildState.build;
    const saving = postBuildWrite("/api/build/rename", { repertoire_id: "r" });
    buildState.build = { repertoire_id: "other", revision: 1 };
    reply.resolve({ revision: 5 });
    await saving;
    expect(buildState.build.revision).toBe(1);
    expect(old.revision).toBe(4);
  });

  it("a failed write does not block the next one", async () => {
    postJson.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ revision: 5 });
    await expect(postBuildWrite("/api/build/annotations", { repertoire_id: "r" })).rejects.toThrow("offline");
    await postBuildWrite("/api/build/annotations", { repertoire_id: "r" });
    expect(buildState.build.revision).toBe(5);
  });

  it("drops a queued write once the account changed", async () => {
    const first = deferred();
    postJson.mockReturnValueOnce(first.promise);
    const a = postBuildWrite("/api/build/annotations", { repertoire_id: "r" });
    const b = postBuildWrite("/api/build/annotations", { repertoire_id: "r" });
    appState.ownerGeneration += 1;
    first.resolve({ revision: 5 });
    await a;
    await expect(b).rejects.toThrow("Account changed");
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it("announces nothing for a write to a repertoire that is not open", async () => {
    postJson.mockResolvedValueOnce({ revision: 2 });
    await postBuildWrite("/api/build/rename", { repertoire_id: "elsewhere" });
    expect(announceBuildWrite).not.toHaveBeenCalled();
    expect(buildState.build.revision).toBe(4);
  });
});
