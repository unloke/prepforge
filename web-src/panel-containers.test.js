// Panels whose width comes from the board, the dock or a side column answer
// their layout switches from their own width (@container), and the Games
// ledger skips the rows that are off screen (content-visibility) without losing
// their height.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const styles = read("./styles.css");
const scout = read("./views/scout.css");
const replay = read("./views/replay.css");
const unlock = read("./engine-unlock.css");

describe("panel containers", () => {
  it("names the panel roots", () => {
    expect(styles).toMatch(/#build-sidebar \{ container: build-panel \/ inline-size; \}/);
    expect(styles).toMatch(/#build-inspector \{ container: dock \/ inline-size; \}/);
    expect(styles).toMatch(/\.coach-card,\n\.an-pane,\n#analysis-eval-card \{ container-type: inline-size; \}/);
    expect(styles).toMatch(/\.engine-slot \{ container: engine-card \/ inline-size; \}/);
    expect(styles).toMatch(/\.scout-main \{[^}]*container: scout-main \/ inline-size;/);
    expect(styles).toMatch(/\.scout-side \{[^}]*container: scout-side \/ inline-size;/);
    expect(replay).toContain("#view-replay .ledger { container: ledger / inline-size; }");
    expect(replay).toContain("#view-replay .focus { container: focus / inline-size; }");
    expect(unlock).toContain("[data-unlock-place] { container: unlock / inline-size; }");
  });

  it("switches row layouts on the panel's width, not the window's", () => {
    expect(scout).toMatch(/@container scout-main \(max-width: 800px\) \{\s*\.line-row \{ grid-template-columns: minmax\(0, 1fr\) 70px 72px 40px; \}/);
    expect(scout).not.toContain("@media (max-width: 1279px)");
    expect(replay).toMatch(/@container ledger \(max-width: 700px\) \{\s*\.lr \{[^}]*\}\s*\.lr > :nth-child\(4\) \{ display: none; \}/);
    // The badge column holds "Opponent left prep" at every width, so it never runs into the game column.
    expect(replay).toMatch(/\.lr \{[^}]*grid-template-columns: 156px minmax\(160px, 240px\) 52px minmax\(120px, 200px\) 80px;/);
    expect(replay).toContain(".lr { grid-template-columns: 156px minmax(110px, 1fr) 52px 80px; }");
    // The page-level split stays a viewport query.
    expect(replay).toMatch(/@media \(max-width: 1279px\) \{\s*\.triage \{ grid-template-columns: minmax\(0, 1fr\) 380px; \}\s*\}/);
    expect(unlock).toMatch(/@container unlock \(max-width: 440px\) \{\s*\.unlock:not\(\.is-inline\) \{ grid-template-columns/);
  });

  it("skips off-screen Games ledger rows with a placeholder the size of a row's content", () => {
    expect(replay).toContain(".ledger-table .lr:not(.head) { content-visibility: auto; contain-intrinsic-size: auto 30px; }");
    expect(replay).toMatch(/\(min-height: 521px\) \{[\s\S]*\.ledger-table \.lr:not\(\.head\) \{ contain-intrinsic-size: auto 52px; \}/);
    // A sticky header is never skipped.
    expect(replay).not.toMatch(/\.lr\.head[^{]*\{[^}]*content-visibility/);
    // Measured without a gain: the Scout plan rows, the chart strip and Library rows paint whole.
    for (const sheet of [scout, styles]) expect(sheet).not.toContain("content-visibility");
  });
});
