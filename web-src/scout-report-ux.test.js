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
    expect(String(html)).toContain("scout-wdlbar-w");
    expect(String(html)).toContain("scout-wdlbar-d");
    expect(String(html)).toContain("scout-wdlbar-l");
    expect(String(html)).toContain("1W");
    expect(String(html)).toContain("0D");
    expect(String(html)).toContain("0L");
  });

  it("Run Deep scan is a bordered button; its explanation is a tooltip, not standing copy", () => {
    const html = renderScoutRefutationGapActions(
      [{ id: "deep-scan", label: "Run Deep scan", ariaLabel: "Run deep scan", testId: "t" }],
    );
    expect(String(html)).toContain('class="scout-btn btn sm scout-refutation-gap-btn"');
    expect(String(html)).not.toContain("btn ghost");
    expect(String(html)).not.toContain("scout-refutation-gap-lead");
    expect(String(html)).toMatch(/title="Engine refutations for these lines need a Stockfish pass"/);
  });

  it("W/D/L bar can drop its count labels (row cells keep them in the tooltip)", () => {
    const html = scoutWdlBar(3, 1, 2, { counts: false });
    expect(String(html)).not.toContain("scout-wdlbar-nums");
    expect(String(html)).toContain('title="W3 D1 L2"');
  });

  it("labels only the games in the rendered report, never the live fetch lag", () => {
    expect(scoutAnalyzedLabel(66)).toBe("66 games analyzed");
    expect(scoutAnalyzedLabel(1)).toBe("1 game analyzed");
    const html = renderScoutProfile({ total: 59, speedCounts: {} }, "DrNykterstein", "all");
    expect(String(html)).toContain("59 games analyzed");
    expect(String(html)).not.toMatch(/ of \d+ games analyzed/);
  });

  it("links a single Lichess user but never an aggregated self label", () => {
    const one = String(renderScoutProfile({ total: 5, speedCounts: {} }, "DrNykterstein", "all"));
    expect(one).toContain('href="https://lichess.org/@/DrNykterstein"');
    const self = String(
      renderScoutProfile({ total: 5, speedCounts: {} }, "self (2 accounts)", "all", { usernames: ["a1", "b2"] }),
    );
    expect(self).not.toContain("lichess.org/@/");
    expect(self).toContain('title="a1, b2"');
  });

  it("system setups get display names, not lowercase ids", () => {
    expect(systemSetupName("kia")).toBe("King's Indian Attack");
    expect(systemSetupName("london")).toBe("London");
    expect(systemSetupName("hippo")).toBe("Hippopotamus");
    expect(systemSetupName(null)).toBeNull();
  });
});
