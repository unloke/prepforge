import { describe, expect, it } from "vitest";
import { smartSessionOutcomeText } from "./controllers/train-session.js";

describe("smart session outcome copy", () => {
  it("reports zero review attempts as learning rather than a failed score", () => {
    expect(smartSessionOutcomeText({}, { correct: 0, mistakes: 0 })).toBe(
      "New moves learned. No review moves scored yet.",
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
