// UX walkthrough 2026-09-30 P2-10: before Start, say how big the session is.
import { describe, expect, it } from "vitest";

import { sessionPreviewText } from "./train.js";

describe("sessionPreviewText", () => {
  it("caps new moves per session (the walkthrough's 4 cards out of 41 new)", () => {
    expect(sessionPreviewText({ weak: 0, due: 0, untrained: 41 })).toBe("4 cards this session · 41 new available");
  });

  it("counts reviews first and caps the session size", () => {
    expect(sessionPreviewText({ weak: 2, due: 3, untrained: 1 })).toBe("6 cards this session · 5 due · 1 new available");
    expect(sessionPreviewText({ weak: 10, due: 10, untrained: 9 })).toMatch(/^12 cards this session/);
  });

  it("handles an empty queue and missing data", () => {
    expect(sessionPreviewText({ weak: 0, due: 0, untrained: 0 })).toBe("Nothing due, a short polish session");
    expect(sessionPreviewText(null)).toBe("");
  });
});
