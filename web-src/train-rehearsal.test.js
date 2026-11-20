import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadRehearsal, restoreRehearsal, saveRehearsal } from "./train-rehearsal.js";
import { formatWorkspaceHash, parseWorkspaceHash, workspaceLocationFromState } from "./workspace-url.js";
import { appSource } from "./test-app-source.js";

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
  const restored = restoreRehearsal("u", training).stats;
  expect({ ...restored, skipped: restored.skipped + 1 }).toMatchObject({ skipped: 2, correct: 0, mistakes: 0 });
  expect(restoreRehearsal("other", training)).toBeNull();
  expect(restoreRehearsal("u", { ...training, session_id: "new" })).toBeNull();
});
it("rejects counters when deleting a paused line rebuilds the same server session", () => {
  saveRehearsal("u", training, stats, 1);
  const rebuilt = { ...training, line_order: ["line-a"], prompt: { current_index: 0, total_lines: 1 } };
  expect(restoreRehearsal("u", rebuilt)).toBeNull();
  expect(restoreRehearsal("u", { ...training, prompt: { ...training.prompt, current_index: 0 } })).toBeNull();
});
it("restores a missed prompt's retry attempt but not onto an advanced prompt", () => {
  saveRehearsal("u", training, { ...stats, mistakes: 1, history: [false] }, 2);
  expect(restoreRehearsal("u", training)).toMatchObject({ attempt: 2, stats: { mistakes: 1, history: [false] } });
  expect(restoreRehearsal("u", { ...training, prompt: { ...training.prompt, fen_before: "next position" } }).attempt).toBe(1);
  expect(restoreRehearsal("u", { ...training, prompt: { ...training.prompt, current_index: 2 } }).attempt).toBe(1);
});
it("reload after a miss sends attempt 2 and a correct retry does not earn first-try credit", async () => {
  const payload = { ...training, prompt: { ...training.prompt, session_id: "s", line_node_id: "line-b", fen_before: "position" } };
  const missed = { ...stats, mistakes: 1, streak: 0, best: 0, history: [false] };
  saveRehearsal("u", payload, missed, 2);
  const appState = { signedIn: true, trainMode: "all_lines", trainingRepertoireId: "r" };
  const deps = {
    appState, currentOwnerId: () => "u", restoreRehearsal,
    postJson: vi.fn(async () => payload), hardFlushBuild: async () => {},
    trainStatsReset: () => { appState.trainStats = { ...stats }; },
    clearBlitzTimer: vi.fn(), setBlitzBarVisible: vi.fn(), setTrainBanner: vi.fn(),
    syncTrainSessionControls: vi.fn(), renderTrainStats: vi.fn(), renderTraining: vi.fn(), syncWorkspaceUrl: vi.fn(),
    trainRowError: vi.fn(), isNothingToTrainError: () => false,
    boards: { train: { setEngineArrow: vi.fn(), setPosition: vi.fn() } },
    currentTrainingPrompt: () => appState.training.prompt,
    optimisticBoardMove: async () => {}, localDateString: () => "2026-11-20",
    api: vi.fn(async () => ({ correct: true, prompt: null })),
    playSound: vi.fn(), sleep: async () => {}, finishTrainingSession: vi.fn(),
  };
  const source = appSource();
  const compile = (marker) => {
    const start = source.indexOf(marker);
    const body = source.slice(start, source.indexOf("\n}\n", start) + 2);
    return new Function(...Object.keys(deps), `let smartStartSeq = 0; return (${body});`)(...Object.values(deps));
  };
  await compile("async function startTraining(")("all_lines");
  expect(appState.trainAttempt).toBe(2);
  await compile("async function submitTrainingMove(")("e2e4");
  expect(JSON.parse(deps.api.mock.calls[0][1].body).attempt).toBe(2);
  expect(appState.trainStats).toMatchObject({ correct: 0, mistakes: 1, history: [false] });
});
it("empty, completed and unavailable storage cannot offer a rehearsal resume", () => {
  expect(loadRehearsal("u", "r")).toBeNull();
  saveRehearsal("u", training, stats, 1);
  saveRehearsal("u", { ...training, prompt: null }, stats, 1);
  expect(loadRehearsal("u", "r")).toBeNull();
  vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); } });
  expect(loadRehearsal("u", "r")).toBeNull();
});
