import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadRehearsal, rehearsalStats, saveRehearsal } from "./train-rehearsal.js";
import { formatWorkspaceHash, parseWorkspaceHash, workspaceLocationFromState } from "./workspace-url.js";

const training = { repertoire_id: "r", session_id: "s", line_order: ["line-a", "line-b"], prompt: { current_index: 1, total_lines: 2 } };
const stats = { correct: 0, mistakes: 0, skipped: 1, history: [] };
beforeEach(() => {
  const data = new Map();
  vi.stubGlobal("localStorage", { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

it("reload keeps the rehearsal route and server line position", () => {
  const hash = formatWorkspaceHash(workspaceLocationFromState({ currentView: "train", training }));
  expect(hash).toBe("#/train?rep=r&mode=all_lines");
  expect(parseWorkspaceHash(hash)).toMatchObject({ trainMode: "all_lines", repertoireId: "r" });
  saveRehearsal("u", training, stats, 1);
  expect(loadRehearsal("u", "r").training.prompt.current_index).toBe(1);
});
it("restores only the rehearsal's own counters after a Due run", () => {
  saveRehearsal("u", training, stats, 1);
  const restored = rehearsalStats("u", training);
  expect({ ...restored, skipped: restored.skipped + 1 }).toMatchObject({ skipped: 2, correct: 0, mistakes: 0 });
  expect(rehearsalStats("other", training)).toBeNull();
  expect(rehearsalStats("u", { ...training, session_id: "new" })).toBeNull();
});
it("rejects counters when deleting a paused line rebuilds the same server session", () => {
  saveRehearsal("u", training, stats, 1);
  const rebuilt = { ...training, line_order: ["line-a"], prompt: { current_index: 0, total_lines: 1 } };
  expect(rehearsalStats("u", rebuilt)).toBeNull();
  expect(rehearsalStats("u", { ...training, prompt: { ...training.prompt, current_index: 0 } })).toBeNull();
});
it("empty, completed and unavailable storage cannot offer a rehearsal resume", () => {
  expect(loadRehearsal("u", "r")).toBeNull();
  saveRehearsal("u", training, stats, 1);
  saveRehearsal("u", { ...training, prompt: null }, stats, 1);
  expect(loadRehearsal("u", "r")).toBeNull();
  vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); } });
  expect(loadRehearsal("u", "r")).toBeNull();
});
