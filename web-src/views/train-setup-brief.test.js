// The setup briefing names the queue Start will serve: its size (the one
// number the screen leads with), what it is made of, polish included.
import { describe, expect, it } from "vitest";

import { sessionBrief, queueSources, summaryStatCells } from "./train.js";

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

describe("queueSources", () => {
  const rep = (id, name, health, color = "white", extra = {}) => ({ id, name, color, is_active: true, health, ...extra });

  it("lists the repertoires the queue draws from, with their mastery", () => {
    expect(queueSources([
      rep("r1", "Caro-Kann: Advance", { trainable: 10, mastered: 3, mastery_pct: 30 }, "black"),
      rep("r2", "London System", { trainable: 8, mastered: 5, mastery_pct: 62 }),
    ])).toEqual([
      { name: "Caro-Kann: Advance", black: true, trainable: 10, mastered: 3, pct: 30 },
      { name: "London System", black: false, trainable: 8, mastered: 5, pct: 62 },
    ]);
  });

  it("leaves out what contributes no cards: empty, inactive or being deleted", () => {
    expect(queueSources([
      rep("r1", "Empty", { trainable: 0, mastered: 0, mastery_pct: 0 }),
      rep("r2", "Inactive", { trainable: 4, mastered: 0, mastery_pct: 0 }, "white", { is_active: false }),
      rep("r3", "Deleting", { trainable: 4, mastered: 0, mastery_pct: 0 }),
      rep("r4", "Live", { trainable: 4, mastered: 2, mastery_pct: 50 }),
    ], new Set(["r3"])).map((r) => r.name)).toEqual(["Live"]);
  });

  it("survives a repertoire whose health never arrived", () => {
    expect(queueSources([rep("r1", "Fresh", null)])).toEqual([
      { name: "Fresh", black: false, trainable: 0, mastered: 0, pct: 0 },
    ]);
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
