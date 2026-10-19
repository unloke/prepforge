import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { planRowEntranceEnabled, scoutRenderDebounceMs, scoutRenderForceEvery } from "./scout.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("scout streaming render cadence", () => {
  it("forces fewer rerenders as game count grows", () => {
    expect(scoutRenderForceEvery(50)).toBe(25);
    expect(scoutRenderForceEvery(150)).toBe(50);
    expect(scoutRenderForceEvery(400)).toBe(100);
    expect(scoutRenderForceEvery(800)).toBe(200);
  });

  it("waits longer between debounced rerenders for large histories", () => {
    expect(scoutRenderDebounceMs(100)).toBe(400);
    expect(scoutRenderDebounceMs(300)).toBe(800);
    expect(scoutRenderDebounceMs(700)).toBe(1200);
  });

  it("does not hold new plan rows invisible while games stream", () => {
    // A streaming rebuild must paint rows immediately; the staggered enter fade
    // (opacity 0 for up to ~385ms, animation-fill-mode: both) left blank gaps.
    expect(planRowEntranceEnabled("running")).toBe(false);
    expect(planRowEntranceEnabled("idle")).toBe(true);
    expect(planRowEntranceEnabled(undefined)).toBe(true);
  });
});

describe("scout toolbar counter", () => {
  const html = readFileSync(resolve(here, "../index.html"), "utf8");
  const view = readFileSync(resolve(here, "./scout.js"), "utf8");

  it("agrees the fetched noun with the count", () => {
    // "1 games fetched" was left by the round-1 lane: the noun sat in the
    // markup as a constant while the number changed.
    expect(html).toMatch(/id="scout-live-count"[^>]*>0<\/span> <span id="scout-live-noun">games<\/span> fetched/);
    expect(view).toMatch(/nounOf\(fetched, "game"\)/);
  });
});

describe("scout game-plan rows at narrow widths", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("folds the meta column under the line at 1279px (header column hidden too)", () => {
    const at = css.indexOf("@media (max-width: 1279px)");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("@media (max-width: 760px)"));
    expect(block).toMatch(/\.line-row \{ grid-template-columns: minmax\(0, 1fr\) 70px 72px 40px; \}/);
    // UX walkthrough P2-8: hiding only the cells left an empty "Type · last seen"
    // header column. The meta moves under the line and the header drops its slot.
    expect(block).not.toContain(".line-row .lr-meta { display: none; }");
    expect(block).toMatch(/\.line-row \.lr-meta \{ grid-column: 1; grid-row: 2;/);
    expect(block).toContain(".scout-lines-head span:nth-child(2) { display: none; }");
  });

  it("collapses rows to move + score on phones (WDL, meta and flags hidden)", () => {
    const at = css.indexOf("@media (max-width: 760px)");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at);
    expect(block).toMatch(/\.line-row \{ grid-template-columns: 1fr auto;/);
    expect(block).toContain(".line-row .lr-wdl,");
    expect(block).toContain(".line-row .lr-flags { display: none; }");
  });
});

describe("scout report type", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("keeps monospace for nothing on the report: notation is set in the text face", () => {
    // The inspector flags any JetBrains Mono outside <code>: the report set SAN,
    // bar labels and chart axes in it. Figures now use tabular numbers instead.
    expect(css).not.toMatch(/var\(--mono\)/);
    expect(css).toMatch(/\.line-title \{[^}]*font-variant-numeric: tabular-nums/);
    expect(css).toMatch(/\.scout-bar-val \{[^}]*font-variant-numeric: tabular-nums/);
  });

  it("raises the report one step above the app's small sizes", () => {
    // 12px meta and 11px labels read as captions; nothing read is under 13px.
    expect(css).toContain(".scout-panel { --fs-s: 13px; --fs-xs: 12px; }");
    expect(css).not.toMatch(/font-size: 11px/);
  });
});

describe("scout accent budget", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("keeps the accent for actions and the open row's bar, not for status chips", () => {
    // Nine accent marks on one screen; the recommendation strip, the "main
    // line" chip and the engine note read as calls to action when they are data.
    expect(css).not.toMatch(/\.c-main \{[^}]*--accent/);
    expect(css).not.toMatch(/\.scout-color-rec \{[^}]*--accent-soft/);
    expect(css).toMatch(/\.line-row\.is-expanded \{[^}]*inset 3px 0 0 var\(--accent\)/);
  });
});
