import { describe, expect, it } from "vitest";

import {
  renderScoutProfile,
  renderScoutRefutationGapActions,
  scoutAnalyzedLabel,
  scoutRowPlyLimit,
  scoutWdlBar,
} from "./scout-report.js";
import { systemSetupName } from "./scout-stats.js";

// UX walkthrough 2026-09-30, P2-8: the Scout "lines" table.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const sans38 = Array.from({ length: 38 }, (_, i) => (i % 2 ? "Nc6" : "Nf3"));

describe("scout lines table", () => {
  it("caps a whole-game row at 8 moves when there is no prep to compare", () => {
    expect(scoutRowPlyLimit({ sans: sans38 })).toBe(16);
    expect(scoutRowPlyLimit({ sans: sans38.slice(0, 6) })).toBe(6);
  });

  it("shows up to the deviation point (min 4, max 12 moves)", () => {
    expect(scoutRowPlyLimit({ sans: sans38, covered: 2, prepared: false })).toBe(8);
    expect(scoutRowPlyLimit({ sans: sans38, covered: 13, prepared: false })).toBe(14);
    expect(scoutRowPlyLimit({ sans: sans38, covered: 30, prepared: false })).toBe(24);
  });

  it("keeps the whole line when the row names your reply to its final position", () => {
    expect(scoutRowPlyLimit({ sans: sans38, suggestedReply: { uci: "e7e5" } })).toBe(38);
  });

  it("W/D/L bar is three segments with the counts beside it", () => {
    const html = scoutWdlBar(1, 0, 0);
    expect(html).toContain("scout-wdlbar-w");
    expect(html).toContain("scout-wdlbar-d");
    expect(html).toContain("scout-wdlbar-l");
    expect(html).toContain("1W");
    expect(html).toContain("0D");
    expect(html).toContain("0L");
  });

  it("Run Deep scan is a bordered button with a lead-in, not a bare text line", () => {
    const html = renderScoutRefutationGapActions(
      [{ id: "deep-scan", label: "Run Deep scan", ariaLabel: "Run deep scan", testId: "t" }],
      esc,
    );
    expect(html).toContain('class="scout-btn btn sm scout-refutation-gap-btn"');
    expect(html).not.toContain("btn ghost");
    expect(html).toContain("scout-refutation-gap-lead");
  });

  it("labels only the games in the rendered report, never the live fetch lag", () => {
    expect(scoutAnalyzedLabel(66)).toBe("66 games analyzed");
    expect(scoutAnalyzedLabel(1)).toBe("1 game analyzed");
    const html = renderScoutProfile({ total: 59, speedCounts: {} }, "DrNykterstein", "all", esc);
    expect(html).toContain("59 games analyzed");
    expect(html).not.toMatch(/ of \d+ games analyzed/);
  });

  it("system setups get display names, not lowercase ids", () => {
    expect(systemSetupName("kia")).toBe("King's Indian Attack");
    expect(systemSetupName("london")).toBe("London");
    expect(systemSetupName("hippo")).toBe("Hippopotamus");
    expect(systemSetupName(null)).toBeNull();
  });
});
