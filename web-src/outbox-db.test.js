import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { clearDurableOutbox, loadDurableOutbox, saveDurableOutbox } from "./outbox-db.js";
import { flushGroups, groupAttempts, ungroupAttempts } from "./train-sync.js";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sample = () => ({ build: { pending: [{ tempId: "tmp-a", repertoireId: "r", uci: "e2e4" }],
  pendingDeletes: [{ id: "n", repertoireId: "r" }], idMap: { "tmp-old": "real-old" },
  rejected: [{ tempId: "bad", error: "invalid" }] },
  train: { pending: [{ attempt_uuid: "attempt", session_id: "s", node_id: "n" }], rejected: [] },
});

it("keeps each owner's work separate", async () => {
  await saveDurableOutbox("a", sample(), { build: ["older"] });
  const stored = await loadDurableOutbox("a");
  expect(stored.build.pending).toEqual(sample().build.pending);
  expect(stored.settled.build).toContain("older");
  expect((await loadDurableOutbox("b")).build.pending).toEqual([]);
});

it("an aborted write leaves no partial commit", async () => {
  await saveDurableOutbox("a", sample());
  const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
  await expect(saveDurableOutbox("a", { train: { pending: [{ attempt_uuid: "new" }] } }))
    .rejects.toMatchObject({ name: "QuotaExceededError" });
  put.mockRestore();
  expect((await loadDurableOutbox("a")).train.pending.map((op) => op.attempt_uuid)).toEqual(["attempt"]);
});

it("concurrent transactions merge independent tabs instead of overwriting each other", async () => {
  await Promise.all(Array.from({ length: 30 }, (_, i) => saveDurableOutbox("a", {
    train: { pending: [{ attempt_uuid: `u-${i}` }] },
  })));
  expect((await loadDurableOutbox("a")).train.pending).toHaveLength(30);
});

it("a stale writer cannot replay settled adds/deletes/attempts", async () => {
  const stale = sample();
  await saveDurableOutbox("a", stale);
  await saveDurableOutbox("a", {}, { build: ["tmp-a"], deletes: ["n"], train: ["attempt"] });
  await clearDurableOutbox("a");
  await saveDurableOutbox("a", stale);
  const restored = await loadDurableOutbox("a");
  expect(restored.build.pending).toEqual([]);
  expect(restored.build.pendingDeletes).toEqual([]);
  expect(restored.train.pending).toEqual([]);
  expect(restored.build.rejected).toEqual(stale.build.rejected);
  expect(restored.build.idMap).toEqual(stale.build.idMap);
});

it("clear never erases another tab's work", async () => {
  await saveDurableOutbox("a", { train: { pending: [{ attempt_uuid: "other" }] } });
  await clearDurableOutbox("a");
  expect((await loadDurableOutbox("a")).train.pending).toHaveLength(1);
});

it("settlements outlive many later edits in a suspended tab", async () => {
  await saveDurableOutbox("a", {}, { build: ["old"] });
  for (let i = 0; i < 250; i++) await saveDurableOutbox("a", {}, { build: [`new-${i}`] });
  await saveDurableOutbox("a", { build: { pending: [{ tempId: "old", uci: "e2e4" }] } });
  expect((await loadDurableOutbox("a")).build.pending).toEqual([]);
});

it("rejected training attempts stay reviewable but never return to pending", async () => {
  const attempts = [{ session_id: "s", node_id: "n", correct: true, attempt_uuid: "u" }];
  await saveDurableOutbox("a", { train: { pending: attempts } });
  const outcome = await flushGroups(groupAttempts(attempts), async () => {
    throw Object.assign(new Error("gone"), { status: 404 });
  });
  await saveDurableOutbox("a", {
    train: { pending: ungroupAttempts(outcome.failedGroups), rejected: outcome.rejectedGroups },
  });
  await saveDurableOutbox("a", { train: { pending: attempts } });
  const stored = await loadDurableOutbox("a");
  expect(stored.train.pending).toEqual([]);
  expect(stored.train.rejected).toHaveLength(1);
});

it("queued writes snapshot mutable queues before awaiting database initialization", async () => {
  const state = sample();
  const saving = saveDurableOutbox("a", state);
  state.build.pending.length = 0;
  await saving;
  expect((await loadDurableOutbox("a")).build.pending).toHaveLength(1);
});
