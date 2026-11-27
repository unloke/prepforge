import { describe, expect, it, vi } from "vitest";
import { createBuildMastery, masteryOf } from "./build-mastery.js";

const reply = (id, revision, mastery) => ({ repertoire_id: id, revision, mastery });

function harness(build, { sharedToken = null } = {}) {
  const buildState = { build, buildMastery: null };
  const appState = { sharedToken };
  const pending = [];
  const api = vi.fn((url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })));
  const repaint = vi.fn();
  const mastery = createBuildMastery({ api, appState, buildState, repaint });
  return { buildState, api, repaint, pending, mastery };
}

describe("Build mastery: Train's colour beside the tree", () => {
  it("asks Train for the owner's colour of the open tree and repaints once it lands", async () => {
    const h = harness({ repertoire_id: "r1", revision: 3, role: "owner", nodes: [] });
    const done = h.mastery.refresh();
    expect(h.api).toHaveBeenCalledWith("/api/train/mastery?repertoire_id=r1");
    h.pending[0].resolve(reply("r1", 3, { a: "weak" }));
    await done;
    expect(masteryOf(h.buildState, "a")).toBe("weak");
    expect(masteryOf(h.buildState, "b")).toBeNull();
    expect(h.repaint).toHaveBeenCalledTimes(1);
  });

  it("asks again when the same revision is re-read: training moves the colour, not the tree", async () => {
    const h = harness({ repertoire_id: "r1", revision: 3, role: "owner", nodes: [] });
    const first = h.mastery.refresh();
    h.pending[0].resolve(reply("r1", 3, { a: "untrained" }));
    await first;
    // A finished Train session re-reads the open tree; its revision is unchanged.
    const second = h.mastery.refresh();
    expect(h.api).toHaveBeenCalledTimes(2);
    h.pending[1].resolve(reply("r1", 3, { a: "learning" }));
    await second;
    expect(masteryOf(h.buildState, "a")).toBe("learning");
    expect(h.repaint).toHaveBeenCalledTimes(2);
  });

  it("colours nothing it can't own: a shared tree or a public link never asks", async () => {
    const shared = harness({ repertoire_id: "r1", revision: 1, role: "edit", shared: true, nodes: [] });
    await shared.mastery.refresh();
    const link = harness({ repertoire_id: "r1", revision: 1, role: "owner", nodes: [] }, { sharedToken: "tok" });
    await link.mastery.refresh();
    expect(shared.api).not.toHaveBeenCalled();
    expect(link.api).not.toHaveBeenCalled();
    expect(shared.buildState.buildMastery).toBeNull();
  });

  it("asks once more after an edit lands mid-request, and never keeps an older answer", async () => {
    const h = harness({ repertoire_id: "r1", revision: 1, role: "owner", nodes: [] });
    const done = h.mastery.refresh();
    h.buildState.build = { ...h.buildState.build, revision: 2 };
    h.mastery.refresh();
    expect(h.api).toHaveBeenCalledTimes(1);
    h.pending[0].resolve(reply("r1", 1, { a: "untrained" }));
    await vi.waitFor(() => expect(h.api).toHaveBeenCalledTimes(2));
    h.pending[1].resolve(reply("r1", 2, { a: "learning" }));
    await done;
    expect(masteryOf(h.buildState, "a")).toBe("learning");
    expect(h.buildState.buildMastery.revision).toBe(2);
  });

  it("drops another repertoire's colour as soon as a different tree opens", async () => {
    const h = harness({ repertoire_id: "r1", revision: 1, role: "owner", nodes: [] });
    const first = h.mastery.refresh();
    h.pending[0].resolve(reply("r1", 1, { a: "due" }));
    await first;
    h.buildState.build = { repertoire_id: "r2", revision: 1, nodes: [] };
    expect(masteryOf(h.buildState, "a")).toBeNull();
    const second = h.mastery.refresh();
    expect(h.buildState.buildMastery).toBeNull();
    h.pending[1].resolve(reply("r2", 1, { b: "mastered" }));
    await second;
    expect(masteryOf(h.buildState, "b")).toBe("mastered");
  });
});
