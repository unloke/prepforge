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

describe("scout game-plan rows at narrow widths", () => {
  const css = readFileSync(resolve(here, "./scout.css"), "utf8");

  it("drops the meta column at 1279px so the score / WDL / action cells keep their room", () => {
    const at = css.indexOf("@media (max-width: 1279px)");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("@media (max-width: 760px)"));
    expect(block).toMatch(/\.line-row \{ grid-template-columns: minmax\(0, 1fr\) 70px 110px 40px; \}/);
    expect(block).toContain(".line-row .lr-meta { display: none; }");
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
