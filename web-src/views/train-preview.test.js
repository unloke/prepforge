// The preview names the cards Start will serve, polish included.
import { describe, expect, it } from "vitest";

import { sessionPreviewText } from "./train.js";

describe("sessionPreviewText", () => {
  it("counts every card kind, polish included", () => {
    expect(sessionPreviewText({ cards: 11, weak: 1, due: 0, new: 4, polish: 6, resumed: 0 }))
      .toBe("11 cards · 1 weak · 4 new · 6 polish");
  });

  it("says what is left of a resumable session", () => {
    expect(sessionPreviewText({ cards: 1, weak: 0, due: 1, new: 0, polish: 0, resumed: 1 }))
      .toBe("1 card left · 1 due");
  });

  it("handles an empty queue and missing data", () => {
    expect(sessionPreviewText({ cards: 0, weak: 0, due: 0, new: 0, polish: 0, resumed: 0 })).toBe("No moves to train yet");
    expect(sessionPreviewText(null)).toBe("");
  });
});
