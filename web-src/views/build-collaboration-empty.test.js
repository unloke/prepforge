// Build's Activity and discussion panels: an empty list says so instead of
// leaving a blank area (an empty array is truthy, so `[].map() || fallback`
// never reached the fallback).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialogs = [];
vi.mock("../core/dialog.js", () => ({
  modalDialog: () => {
    const stub = () => ({ addEventListener() {}, focus() {}, value: "", disabled: false });
    const body = { get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); }, querySelector: stub, querySelectorAll: () => [] };
    const dialog = { open: true, innerHTML: "", querySelector: (sel) => (sel === ".lineage-body" ? body : stub()), body };
    dialogs.push(dialog);
    return dialog;
  },
  openModal: () => () => {},
}));

import { createBuildCollaboration } from "./build-collaboration.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function collaboration({ entries = [], threads = [] } = {}) {
  const appState = {
    ownerGeneration: 1, signedIn: true, sharedToken: null,
    build: { repertoire_id: "rep-1", revision: 3 },
    buildNodeById: new Map([["root", { id: "root", fen: START }]]),
    buildCurrentNodeId: "root",
  };
  const api = vi.fn(async (url) => (url.includes("/activity")
    ? { entries, unread_nodes: [], revision: 3, truncated: false }
    : { threads }));
  return createBuildCollaboration({ appState, api, postJson: vi.fn(), hydrateBuild: vi.fn(), selectBuildNode: vi.fn(), showInputModal: vi.fn(), miniBoard: () => "" });
}

beforeEach(() => { dialogs.length = 0; vi.stubGlobal("document", { getElementById: () => null, querySelectorAll: () => [] }); });
afterEach(() => vi.unstubAllGlobals());

describe("Build collaboration empty states", () => {
  it("Activity with no edits says so", async () => {
    await collaboration().openActivity();
    expect(dialogs[0].body.innerHTML).toContain("No edits yet.");
  });

  it("a discussion with no messages says so", async () => {
    const threads = [{ id: "t1", position_key: START.split(" ").slice(0, 4).join(" "), node_id: "root", fen: START, messages: [], resolved: false }];
    await collaboration({ threads }).openDiscussion();
    expect(dialogs[0].body.innerHTML).toContain("No messages yet.");
  });
});
