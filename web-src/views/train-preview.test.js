// Summary health counts targets; it cannot promise the merged card count.
import { describe, expect, it } from "vitest";

import { sessionPreviewText } from "./train.js";

describe("sessionPreviewText", () => {
  it("caps new moves per session (the walkthrough's 4 cards out of 41 new)", () => {
    expect(sessionPreviewText({ weak: 0, due: 0, untrained: 41 })).toBe("41 new available (up to 4 this session)");
  });

  it("names available review moves without claiming a card count", () => {
    expect(sessionPreviewText({ weak: 2, due: 3, untrained: 1 })).toBe("5 review moves ready · 1 new available (up to 1 this session)");
    expect(sessionPreviewText({ weak: 10, due: 10, untrained: 9 })).toMatch(/^20 review moves ready/);
    // The real scheduler merges the three due moves on one line and adds a
    // polish card: this health can yield two cards containing five targets.
    expect(sessionPreviewText({ trainable: 5, mastered: 2, weak: 0, due: 3, untrained: 0 })).toBe("3 review moves ready");
  });

  it("handles an empty queue and missing data", () => {
    expect(sessionPreviewText({ weak: 0, due: 0, untrained: 0 })).toBe("No moves to train yet");
    expect(sessionPreviewText({ trainable: 5, weak: 0, due: 0, untrained: 0 })).toBe("Nothing due — polish available");
    expect(sessionPreviewText(null)).toBe("");
  });
});
