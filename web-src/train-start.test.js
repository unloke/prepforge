// The Train panel's Start button: when it must be dead, and why.
import { describe, expect, it } from "vitest";

import { trainStartBlockReason, trainStartDisabled } from "./train-start.js";

describe("trainStartDisabled", () => {
  it("keeps a guest's Line rehearsal Start clickable so the click reaches the sign-in gate", () => {
    expect(trainStartDisabled({ mode: "all_lines", signedIn: false, hasRepertoire: false })).toBe(false);
  });

  it("waits on the picker for a signed-in user without a repertoire", () => {
    expect(trainStartDisabled({ mode: "all_lines", signedIn: true, hasRepertoire: false })).toBe(true);
    expect(trainStartDisabled({ mode: "all_lines", signedIn: true, hasRepertoire: true })).toBe(false);
  });

  it("never disables Smart queue or Play here", () => {
    for (const mode of ["smart", "play"]) {
      expect(trainStartDisabled({ mode, signedIn: true, hasRepertoire: false })).toBe(false);
      expect(trainStartDisabled({ mode, signedIn: false, hasRepertoire: false })).toBe(false);
    }
  });
});

describe("trainStartBlockReason (smart queue)", () => {
  it("names the missing lines when a repertoire exists but has nothing to train", () => {
    expect(trainStartBlockReason({ cards: 0, weak: 0, due: 0, new: 0, polish: 0, resumed: 0 }, { hasActiveRepertoire: true }))
      .toBe("Nothing due. Add lines in Repertoire.");
  });

  it("names the missing repertoire when there is none", () => {
    expect(trainStartBlockReason({ cards: 0, resumed: 0 }, { hasActiveRepertoire: false }))
      .toBe("No active repertoire. Create one in Library.");
  });

  it("stays silent for a queue with cards, including a resumable one", () => {
    expect(trainStartBlockReason({ cards: 11, weak: 1, due: 0, new: 4, polish: 6 }, { hasActiveRepertoire: true })).toBe("");
    expect(trainStartBlockReason({ cards: 1, resumed: 1 }, { hasActiveRepertoire: true })).toBe("");
  });

  it("stays silent when the preview never arrived (offline, cache cleared)", () => {
    expect(trainStartBlockReason(null, { hasActiveRepertoire: false })).toBe("");
    expect(trainStartBlockReason(undefined, { hasActiveRepertoire: true })).toBe("");
  });
});
