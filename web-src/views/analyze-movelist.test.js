import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ANALYZE_SOURCE = readFileSync(new URL("./analyze.js", import.meta.url), "utf8");

describe("Analyze move list signs", () => {
  // A check after every sound move buried the marks that matter in a long game.
  it("signs only the moves that stand out, not every sound one", () => {
    expect(ANALYZE_SOURCE).toContain('const glyph = group && group !== "good" ? classBadgeSymbol(cls) : "";');
  });
});
