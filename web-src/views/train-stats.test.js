// renderTrainStats paints every counter and the session trail from the live
// stats; a missing element must not stop the others being painted.
import { afterEach, describe, expect, it } from "vitest";

import { createTrainView } from "./train.js";

function elements(ids) {
  const out = {};
  for (const id of ids) out[id] = { id, textContent: "", innerHTML: "", hidden: false, style: {}, classList: { toggle() {}, add() {}, remove() {} } };
  out["train-stat-streak"].closest = () => null;
  return out;
}

function view(appState, els) {
  globalThis.document = { getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
  return createTrainView({ appState, boards: {}, renderSyncChip: () => {}, setTrainBanner: () => {}, updateTrainTurnBadge: () => {}, onStreakRendered: () => {} });
}

afterEach(() => { delete globalThis.document; });

describe("renderTrainStats", () => {
  it("paints streak, correct, missed and the trail", () => {
    const els = elements(["train-stat-streak", "train-stat-correct", "train-stat-mistakes", "train-accuracy", "train-line-trail"]);
    const appState = { trainStats: { correct: 2, mistakes: 1, streak: 1, best: 2, history: [true, true, false], lastStreak: 2 } };
    view(appState, els).renderTrainStats();
    expect(els["train-stat-streak"].textContent).toBe("1");
    expect(els["train-stat-correct"].textContent).toBe(2);
    expect(els["train-stat-mistakes"].textContent).toBe(1);
    expect(String(els["train-line-trail"].innerHTML)).toContain('class="ok"');
    expect(String(els["train-line-trail"].innerHTML)).toContain('class="no"');
  });

  it("keeps painting the later counters, which the streak repaint used to starve", () => {
    // The bug: the streak wrote a SafeHtml object to innerHTML ("[object
    // Object]") and re-triggered its pop on every repaint, so the lines after it
    // (correct / missed / accuracy / trail) never ran. They must all land.
    const els = elements(["train-stat-streak", "train-stat-correct", "train-stat-mistakes", "train-accuracy", "train-line-trail"]);
    const appState = { trainStats: { correct: 1, mistakes: 1, streak: 0, best: 1, history: [true, false], lastStreak: 1 } };
    view(appState, els).renderTrainStats();
    expect(els["train-stat-streak"].textContent).toBe("0");
    expect(els["train-stat-correct"].textContent).toBe(1);
    expect(els["train-stat-mistakes"].textContent).toBe(1);
    expect(els["train-accuracy"].textContent).toBe("50% first try");
  });

  it("pops the streak only when it grows", () => {
    const pops = [];
    const els = elements(["train-stat-streak", "train-stat-correct", "train-stat-mistakes", "train-accuracy", "train-line-trail"]);
    const host = els["train-stat-streak"];
    host.closest = () => ({ offsetWidth: 10, classList: { toggle() {}, add: (c) => pops.push(c), remove() {} } });
    const appState = { trainStats: { correct: 1, mistakes: 0, streak: 1, best: 1, history: [true], lastStreak: 1 } };
    view(appState, els).renderTrainStats();
    expect(pops).toEqual([]);
  });

  it("still paints the counters when the trail is missing", () => {
    const els = elements(["train-stat-streak", "train-stat-correct", "train-stat-mistakes", "train-accuracy"]);
    const appState = { trainStats: { correct: 1, mistakes: 0, streak: 1, best: 1, history: [true], lastStreak: 1 } };
    expect(() => view(appState, els).renderTrainStats()).not.toThrow();
    expect(els["train-stat-correct"].textContent).toBe(1);
  });
});
