import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scoutRenderDebounceMs, scoutRenderForceEvery } from "./scout.js";

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
});

describe("scout ranked list tablet layout (640px)", () => {
  it("hides W/D/L on ranked rows at 720px so three grid columns match three visible cells", () => {
    const css = readFileSync(resolve(here, "../styles.css"), "utf8");
    expect(css).toContain(".scout-ranked-list .scout-ranked-row");
    expect(css).toContain(".scout-ranked-list .scout-lr-wdl { display: none; }");
    const tabletIdx = css.indexOf("@media (max-width: 720px)");
    const phoneIdx = css.indexOf("@media (max-width: 600px)");
    expect(tabletIdx).toBeGreaterThan(-1);
    const tabletCss = css.slice(tabletIdx, phoneIdx > tabletIdx ? phoneIdx : undefined);
    // Rank + share columns removed; tablet: moves, score, action (WDL hidden).
    expect(tabletCss).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) 52px 26px/);
  });
});