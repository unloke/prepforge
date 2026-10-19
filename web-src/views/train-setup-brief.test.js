// The setup briefing names the queue Start will serve: its size (the one
// number the screen leads with), what it is made of, polish included.
import { describe, expect, it } from "vitest";

import { sessionBrief, summaryStatCells } from "./train.js";

describe("sessionBrief", () => {
  it("leads with the size and counts every card kind, polish included", () => {
    expect(sessionBrief({ cards: 11, weak: 1, due: 0, new: 4, polish: 6, resumed: 0 })).toEqual({
      cards: 11,
      label: "cards to train",
      kinds: [["weak", 1], ["new", 4], ["polish", 6]],
    });
  });

  it("names a resumed queue as what is left", () => {
    expect(sessionBrief({ cards: 1, due: 1, resumed: true })).toMatchObject({
      cards: 1,
      label: "card left",
      kinds: [["due", 1]],
    });
  });

  it("says nothing to brief when the queue is empty or unknown", () => {
    expect(sessionBrief({ cards: 0, weak: 0, due: 0, new: 0, polish: 0 })).toBeNull();
    expect(sessionBrief(null)).toBeNull();
  });
});

describe("summaryStatCells", () => {
  it("labels a one-card session in the singular", () => {
    expect(summaryStatCells({ cardsDone: 1 }, { correct: 1, mistakes: 0, best: 1 }))
      .toEqual([[1, "card"], ["100%", "first try"], [1, "best in a row"]]);
  });

  it("adds skipped cards only when something was skipped", () => {
    expect(summaryStatCells({ cardsDone: 4 }, { correct: 3, mistakes: 1, best: 2, skipped: 2 }))
      .toEqual([[4, "cards"], ["75%", "first try"], [2, "best in a row"], [2, "skipped"]]);
    expect(summaryStatCells({ cardsDone: 0 }, {}).length).toBe(3);
  });
});
