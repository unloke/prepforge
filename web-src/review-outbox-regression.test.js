import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearOutbox, loadOutbox, saveOutbox } from "./sync-outbox.js";
import { flushGroups, groupAttempts, ungroupAttempts } from "./train-sync.js";

beforeEach(() => {
  const data = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("a stale tab cannot resurrect settled work after the queue drains", () => {
  const stale = {
    build: { pending: [{ tempId: "tmp-a", uci: "e2e4" }], pendingDeletes: [{ id: "n" }] },
    train: { pending: [{ attempt_uuid: "u" }] },
  };
  saveOutbox("owner", stale);
  saveOutbox("owner", {}, { build: ["tmp-a"], deletes: ["n"], train: ["u"] });
  clearOutbox("owner");
  saveOutbox("owner", stale);
  const restored = loadOutbox("owner");
  expect(restored.build.pending).toEqual([]);
  expect(restored.build.pendingDeletes).toEqual([]);
  expect(restored.train.pending).toEqual([]);
});

it("clear never erases another tab's work", () => {
  saveOutbox("owner", { train: { pending: [{ attempt_uuid: "other" }] } });
  clearOutbox("owner");
  expect(loadOutbox("owner").train.pending).toHaveLength(1);
});

it("settlements outlive more than 200 later edits in a suspended tab", () => {
  saveOutbox("owner", {}, { build: ["old"] });
  for (let i = 0; i < 250; i++) saveOutbox("owner", {}, { build: [`new-${i}`] });
  saveOutbox("owner", { build: { pending: [{ tempId: "old", uci: "e2e4" }] } });
  expect(loadOutbox("owner").build.pending).toEqual([]);
});

it("rejected training attempts stay reviewable but never return to pending", async () => {
  const attempts = [{ session_id: "s", node_id: "n", correct: true, attempt_uuid: "u" }];
  saveOutbox("owner", { train: { pending: attempts } });
  const outcome = await flushGroups(groupAttempts(attempts), async () => {
    throw Object.assign(new Error("gone"), { status: 404 });
  });
  saveOutbox("owner", {
    train: { pending: ungroupAttempts(outcome.failedGroups), rejected: outcome.rejectedGroups },
  });
  saveOutbox("owner", { train: { pending: attempts } });
  expect(loadOutbox("owner").train.pending).toEqual([]);
  expect(loadOutbox("owner").train.rejected).toHaveLength(1);
});
