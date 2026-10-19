// The Train save chip speaks only while progress is on the wire or waiting on
// sign-in: its 4s debounce between answers is the normal state, not news.
import { describe, expect, it } from "vitest";

import { TRAINING_SYNC_TEXT, syncChipVariant } from "./sync-chip.js";

describe("training save chip", () => {
  it("says nothing while the debounce waits", () => {
    expect(TRAINING_SYNC_TEXT).not.toContain("dirty");
    expect(syncChipVariant("dirty", "training").text).toBe("");
  });

  it("still names a save in flight and a save waiting on sign-in", () => {
    expect(syncChipVariant("syncing", "training").text).toBe("↻ Saving progress…");
    expect(syncChipVariant("blocked", "training").text).toContain("Waiting for sign-in");
  });

  it("leaves the Repertoire chip alone", () => {
    expect(syncChipVariant("dirty", "repertoire").text).toBe("• Unsaved changes");
  });
});
