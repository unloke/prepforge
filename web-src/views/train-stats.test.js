// The session shows one stats line, first answers only: the run and the misses.
// Nothing is said before there is something to say.
import { afterEach, describe, expect, it } from "vitest";

import { createTrainView } from "./train.js";

function view(appState, streaks = []) {
  const line = { textContent: "" };
  globalThis.document = { getElementById: (id) => (id === "train-stats-line" ? line : null), querySelector: () => null, querySelectorAll: () => [] };
  const train = createTrainView({ appState, boards: {}, renderSyncChip: () => {}, setTrainBanner: () => {}, updateTrainTurnBadge: () => {}, onStreakRendered: (s) => streaks.push(s) });
  return { train, line };
}

afterEach(() => { delete globalThis.document; });

describe("renderTrainStats", () => {
  it("says the run and the misses in one line", () => {
    const { train, line } = view({ trainStats: { correct: 4, mistakes: 2, streak: 3 } });
    train.renderTrainStats();
    expect(line.textContent).toBe("3 in a row · 2 missed");
  });

  it("leaves out a part that is zero, and says nothing at the start", () => {
    const { train, line } = view({ trainStats: { correct: 1, mistakes: 1, streak: 0 } });
    train.renderTrainStats();
    expect(line.textContent).toBe("1 missed");
    const fresh = view({ trainStats: { correct: 0, mistakes: 0, streak: 0 } });
    fresh.train.renderTrainStats();
    expect(fresh.line.textContent).toBe("");
  });

  it("reports the streak so the board can celebrate a growing run", () => {
    const streaks = [];
    const { train } = view({ trainStats: { correct: 2, mistakes: 0, streak: 2 } }, streaks);
    train.renderTrainStats();
    expect(streaks).toEqual([2]);
  });

  it("survives stats that were never set", () => {
    const { train, line } = view({});
    train.renderTrainStats();
    expect(line.textContent).toBe("");
  });
});
