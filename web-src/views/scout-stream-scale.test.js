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
    // <small> is 0.83em of its parent: the tab and speed-chip counts rendered
    // at 10.8px. They are compared figures, so they take the label's size.
    expect(css).toMatch(/\.scout-color-tab small,\n\.speed small \{ font-size: var\(--fs-s\);/);
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

describe("scout group spacing", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("separates the colour card's groups more than the rows inside them", () => {
    // Head, readout band and plan sat 0-10px apart — one continuous slab.
    const plan = css.match(/\.plan \{[^}]*\}/)[0];
    expect(plan).toContain("gap: 10px");
    expect(plan).toContain("padding: 16px 14px 14px");
    expect(css).toMatch(/\.intel \{[^}]*padding: 12px 14px/);
  });
});

describe("scout streaming skeleton", () => {
  const css = readFileSync(resolve(here, "../styles.css"), "utf8");
  const html = readFileSync(resolve(here, "../index.html"), "utf8");

  it("holds the report's shape while games stream, and only then", () => {
    // Mid-fetch the page was one spinner over blank ground; the report then
    // landed into empty space. The skeleton marks the cards that will arrive.
    expect(html).toContain('class="scout-skeleton" aria-hidden="true"');
    expect(css).toMatch(/\.scout-skeleton \{ display: none;/);
    expect(css).toContain(".scout-panel.is-streaming .scout-skeleton { display: flex; }");
    expect(css).toContain(".scout-panel.is-streaming:not(:has(#scout-results:empty)) .scout-skeleton { display: none; }");
  });

  it("stops pulsing under prefers-reduced-motion", () => {
    const at = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, at + 400)).toContain("scout-skeleton-pulse");
  });
});

describe("scout error state", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("gives the error a title and one plain sentence, not a 182-character strip", () => {
    // The strip was one pink line with no heading: it read as a page banner,
    // and its sentence ran the full width of the window.
    expect(css).toMatch(/\.scout-error-title \{[^}]*font-size: 15px/);
    expect(css).toMatch(/\.scout-error-body \{[^}]*max-width: 70ch/);
    expect(css).toMatch(/\.scout-error-body \{[^}]*font-size: 15px/);
  });
});

describe("scout phone controls", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("gives a first-move row a thumb-sized target and every control press feedback", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
    expect(phone).toMatch(/\.fm \{ min-height: 44px; \}/);
    expect(css).toMatch(/\.fm\[data-first-uci\]:active \{ transform: scale/);
    expect(css).toMatch(/\.scout-add-icon:active \{ transform: scale/);
    expect(css).toMatch(/\.scout-color-tab:active \{ transform: scale/);
  });
});

describe("scout phone composition", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));

  it("puts the game plan before the summary sentence on a phone", () => {
    // The head, a 250px summary band and the plan stacked in source order put
    // the first line 1,228px down at 390x844. The plan is what the page is for.
    expect(phone).toMatch(/\.cs-head \{ order: 0; \}/);
    expect(phone).toMatch(/\.plan \{ order: 1; \}/);
    expect(phone).toMatch(/\.intel \{ order: 2; \}/);
  });

  it("keeps the speed chips and the two actions, and drops the repeated identity", () => {
    // The identity card repeated the player the section head names and the
    // score the colour tabs already show; the chips and actions stay.
    expect(phone).toMatch(/\.scout-panel \.prof-id,\n\s*\.scout-panel \.scout-color-rec \{ display: none; \}/);
    expect(phone).toContain(".scout-panel .prof-row .spacer { display: none; }");
    expect(phone).toContain(".prof-row .btn { min-height: 44px; }");
  });
});

describe("scout line detail card", () => {
  const css = readFileSync(resolve(here, "../styles.css"), "utf8");

  it("ends with its content instead of stretching to the grid row", () => {
    // A line's detail runs 448-536px; stretched to the 808px row it left a
    // 284px white hole under the actions.
    const rule = css.match(/\.scout-side \{[^}]*\}/)[0];
    expect(rule).toContain("align-self: start;");
    expect(rule).toContain("max-height: 100%;");
  });
});

describe("scout colour recommendation", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("hugs its sentence instead of stretching across the profile card", () => {
    // A 256px sentence sat in a 575px grey strip: the box said "banner", the
    // content said "one line of figures".
    const rule = css.match(/\.scout-color-rec \{[^}]*\}/)[0];
    expect(rule).toContain("align-self: flex-start;");
  });
});

describe("scout gap state", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("does not paint every row red for the same reason", () => {
    // All seven rows said "no answer in your prep" in danger red; the colour
    // repeated what the arrow and the words already said. Red stays on the
    // "weak spot" badge, which is not on every row.
    const rule = css.match(/\.then\.needs \{[^}]*\}/)[0];
    expect(rule).toContain("var(--muted)");
    expect(rule).not.toContain("danger");
  });
});

describe("scout stacked detail", () => {
  const js = readFileSync(resolve(here, "./scout.js"), "utf8");

  it("brings the detail into view wherever it stacks under the plan", () => {
    // The card stacks below 1020px; the reveal only fired below 760px, so at
    // 768-1020 opening a row changed something 1,400px below the fold.
    const fn = js.match(/function revealScoutDetail\(\) \{[\s\S]*?\n  \}/)[0];
    expect(fn).toContain('"(max-width: 1020px)"');
  });
});

describe("scout report reading type", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("sets the summary sentence and the chart labels above the row meta", () => {
    // The sentence that explains the section and the labels on the chart bars
    // were set at the same size as the row meta; they are the reading layer.
    expect(css).toMatch(/\.headline \{[^}]*font-size: 16px/);
    expect(css).toMatch(/\.scout-bar-label \{[^}]*font-size: 14px/);
    expect(css).toMatch(/\.scout-chart-title \{[^}]*font-size: 14px/);
  });
});

describe("scout running text", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("sets the line detail's running sentences at body size", () => {
    // The reason and the reply note are the sentences you read in the detail
    // card; the inspector counted them as the page's body text at 15px.
    expect(css).toMatch(/\.scout-line-reason,\n\.scout-line-reply \{[^}]*font-size: 16px/);
  });
});
