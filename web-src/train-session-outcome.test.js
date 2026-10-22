import { describe, expect, it } from "vitest";
import { smartSessionOutcomeText } from "./train-outcome.js";

describe("smart session outcome copy", () => {
  it("counts the new moves learned apart from the review score", () => {
    // A new move is taught, not graded: a wrong first try on it is not a miss.
    expect(smartSessionOutcomeText({}, { correct: 0, mistakes: 0, learned: 3, learnedRetry: 1 })).toBe(
      "3 new moves learned (1 needed a retry). Nothing due for review yet.",
    );
    expect(smartSessionOutcomeText({}, { correct: 2, mistakes: 0, learned: 1 })).toBe(
      "1 new move learned. First-try recall: 2 of 2 review moves.",
    );
  });

  it("uses review moves as the denominator and includes retries and skips", () => {
    expect(
      smartSessionOutcomeText(
        { retriesFixed: 2, blitz: true, timeouts: 1 },
        { correct: 3, mistakes: 1, skipped: 2 },
      ),
    ).toBe(
      "First-try recall: 3 of 4 review moves. 1 missed first try · 2 fixed on retry · 1 timed out · 2 skipped.",
    );
  });

  it("handles a single review move and a clean result", () => {
    expect(smartSessionOutcomeText({}, { correct: 1, mistakes: 0 })).toBe(
      "First-try recall: 1 of 1 review move.",
    );
  });
});
