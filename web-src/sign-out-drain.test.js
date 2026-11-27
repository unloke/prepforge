// Review of #330: signing out while a Train sync was in flight reported
// nothing unsent, because the flush had already taken its attempts off the
// queue. The real controller must wait for that request and, if it fails,
// report the attempts so the sign-out dialog can warn about them.
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSyncController } from "./controllers/sync.js";
import { postJson } from "./core/api.js";
import { resetState } from "./state/state-view.fixture.js";
import { trainState } from "./core/state.js";

vi.mock("./core/api.js", async (orig) => ({ ...await orig(), currentOwnerId: () => "owner", OUTBOX_TAB_ID: "drain-test",
  postJson: vi.fn(), setStatus: vi.fn(), setStatusError: vi.fn() }));
vi.mock("./train-entry.js", async (orig) => ({ ...await orig(), setTrainSyncState: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const locks = new Map();
  vi.stubGlobal("localStorage", { getItem: k => locks.get(k),
    setItem: (k, v) => locks.set(k, v), removeItem: k => locks.delete(k) });
  resetState({ ownerGeneration: 1, buildPending: [], buildPendingDeletes: [], buildIdMap: {}, smart: null,
    trainSync: { pending: [{ session_id: "s", session_generation: "g", node_id: "n", correct: true, attempt_uuid: "u1" }],
      dirty: false, timer: null, flushing: null, retry: 0 } });
  postJson.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

function inFlightSync() {
  let settle;
  postJson.mockImplementation(() => new Promise((resolve, reject) => { settle = { resolve, reject }; }));
  const controller = createSyncController({ captureBuildContext: () => () => true, hydrateBuild: vi.fn() });
  const flushing = controller.flushTrainSync();
  return { controller, flushing, settle: () => settle, started: () => postJson.mock.calls.length === 1 };
}

it("waits for a Train sync in flight before sign-out reports", async () => {
  const h = inFlightSync();
  await vi.waitFor(() => expect(h.started()).toBe(true));
  expect(trainState.trainSync.pending).toEqual([]); // the attempt is out with the request
  let report = null;
  const draining = h.controller.flushAllPendingForSignOut().then((r) => { report = r; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(report).toBeNull();
  h.settle().resolve({ synced: 1 });
  await draining;
  expect(report).toEqual({ pending: 0 });
});

it("reports a Train sync that fails during sign-out as unsaved", async () => {
  const h = inFlightSync();
  await vi.waitFor(() => expect(h.started()).toBe(true));
  const draining = h.controller.flushAllPendingForSignOut();
  h.settle().reject(Object.assign(new Error("offline"), { status: 503 }));
  expect(await draining).toEqual({ pending: 1 });
  expect(trainState.trainSync.pending.map((a) => a.attempt_uuid)).toEqual(["u1"]);
  expect(postJson).toHaveBeenCalledTimes(1);
});

it("counts a Train sync that starts while sign-out is checkpointing", async () => {
  let settle;
  postJson.mockImplementation(() => new Promise((_resolve, reject) => { settle = reject; }));
  const controller = createSyncController({ captureBuildContext: () => () => true, hydrateBuild: vi.fn() });
  const draining = controller.flushAllPendingForSignOut();
  void controller.flushTrainSync(); // starts during the drain's checkpoint
  await vi.waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
  settle(Object.assign(new Error("offline"), { status: 503 }));
  expect(await draining).toEqual({ pending: 1 });
  expect(trainState.trainSync.pending.map((a) => a.attempt_uuid)).toEqual(["u1"]);
});
