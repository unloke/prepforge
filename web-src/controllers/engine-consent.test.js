import { describe, expect, it } from "vitest";
import { engineConsentHtml } from "./engine-consent.js";

// The 94 MB full net is asked for where the engine is first needed: one row in
// the card, two buttons that say what they do, no sentence explaining it.
describe("the engine card's full-net choice", () => {
  it("asks once with both answers", () => {
    const asking = String(engineConsentHtml());
    expect(asking).toContain("Download the full engine?");
    expect(asking).toContain("Download (94 MB)");
    expect(asking).toContain("Keep lite");
    expect(asking).toContain('data-testid="engine-full-choice"');
  });
});
