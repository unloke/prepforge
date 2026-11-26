// Every Build revision used to re-read the discussion list next to the
// activity feed, though a tree edit never changes it, and the list is the
// costlier of the two (it walks the whole tree). Now a revision reads the
// activity feed and reads discussions again only when the feed shows a
// discussion write since the last read. (Opening the discussion dialog still
// reads the list fresh; build-collaboration-empty.test.js covers that.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/dialog.js", () => ({ modalDialog: () => ({}), openModal: () => () => {} }));

import { createBuildCollaboration } from "./build-collaboration.js";
import { asSlices } from "../state/as-slices.fixture.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function setup() {
  const appState = {
    ownerGeneration: 1, signedIn: true, sharedToken: null,
    build: { repertoire_id: "rep-1", revision: 3 },
    buildNodeById: new Map([["root", { id: "root", fen: START }]]),
    buildCurrentNodeId: "root",
  };
  const feed = { entries: [{ revision: 3, kind: "add_moves" }], truncated: false };
  const api = vi.fn(async (url) => (url.includes("/activity")
    ? { ...feed, unread_nodes: [], revision: appState.build.revision }
    : { threads: [] }));
  const collab = createBuildCollaboration({ ...asSlices(appState), api, postJson: vi.fn(),
    hydrateBuild: vi.fn(), selectBuildNode: vi.fn(), showInputModal: vi.fn(), miniBoard: () => "" });
  const reads = () => api.mock.calls.map(([url]) => (url.includes("/activity") ? "activity" : "discussions"));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const revise = async (kind, step = 1) => {
    appState.build.revision += step;
    feed.entries = [{ revision: appState.build.revision, kind }, ...feed.entries];
    collab.sync();
    await settle();
  };
  return { collab, api, feed, reads, settle, revise };
}

beforeEach(() => vi.stubGlobal("document", { getElementById: () => null, querySelectorAll: () => [] }));
afterEach(() => vi.unstubAllGlobals());

describe("Build collaboration reads on a new revision", () => {
  it("reads discussions once, then only after a discussion write", async () => {
    const { collab, api, reads, settle, revise } = setup();
    collab.sync();
    await settle();
    expect(reads()).toEqual(["activity", "discussions"]);
    api.mockClear();
    await revise("add_moves");
    await revise("delete_nodes");
    expect(reads()).toEqual(["activity", "activity"]);
    api.mockClear();
    await revise("discussion");
    expect(reads()).toEqual(["activity", "discussions"]);
  });

  it("reads discussions again when a cut-short feed may have dropped one", async () => {
    const { collab, api, feed, reads, settle, revise } = setup();
    collab.sync();
    await settle();
    api.mockClear();
    // Five writes landed between two reads, and the feed only reaches back to the last one.
    feed.truncated = true;
    feed.entries = [];
    await revise("add_moves", 5);
    feed.entries = feed.entries.slice(0, 1);
    await revise("add_moves");
    expect(reads()).toEqual(["activity", "discussions", "activity"]);
  });

});
