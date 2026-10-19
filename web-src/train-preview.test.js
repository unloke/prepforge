import { describe, expect, it } from "vitest";

import { sessionPreviewText } from "./views/train.js";

describe("sessionPreviewText", () => {
  it("counts in singular and plural, like every other count", () => {
    expect(sessionPreviewText({ cards: 1, weak: 1, due: 0, new: 0, polish: 0 })).toBe("1 card · 1 weak");
    expect(sessionPreviewText({ cards: 2, weak: 1, due: 1, new: 0, polish: 0 })).toBe("2 cards · 1 weak · 1 due");
  });

  it("names a resumed queue as what is left", () => {
    expect(sessionPreviewText({ cards: 3, weak: 0, due: 3, new: 0, polish: 0, resumed: true }))
      .toBe("3 cards left · 3 due");
  });

  it("says an empty queue has nothing to train", () => {
    expect(sessionPreviewText({ cards: 0 })).toBe("No moves to train yet");
    expect(sessionPreviewText(null)).toBe("");
  });
});
