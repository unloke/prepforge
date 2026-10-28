import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CHART_STYLES = readFileSync(new URL("./analyze-chart.css", import.meta.url), "utf8");

// The phone pins the board: the evaluation band over it, the open pillar under
// it, the pillar tabs on the thumb bar. Every band shares the screen's gutter.
describe("Analyze on a phone", () => {
  const phone = CHART_STYLES.slice(CHART_STYLES.indexOf("@media (max-width: 760px) and (orientation: portrait)"));

  it("sets the evaluation over the board as one fixed band on the gutter", () => {
    const band = phone.match(/#view-analyze #analysis-eval-card \{[^}]*\}/)[0];
    expect(band).toMatch(/order: 0/);
    expect(band).toMatch(/height: var\(--phone-eval-h\)/);
    expect(band).toMatch(/padding: 6px var\(--phone-gutter\)/);
    // 64px, not 56: the readout is a whole line and the graph under it has to
    // stay clear of the curve it names.
    expect(phone).toMatch(/--phone-eval-h: 64px/);
  });

  it("gives the eval figure the band's ink and its largest size", () => {
    const rule = phone.match(/#analysis-eval-card \.eval-now \{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toMatch(/font-size:\s*20px/);
    expect(rule[0]).toMatch(/color:\s*var\(--text\)/);
  });

  it("keeps the pillar tabs on the thumb bar at a 44px target, the coach among them", () => {
    expect(phone).toMatch(/--phone-tabs-h: 44px/);
    expect(phone).toMatch(/\.an-panes > \.an-tabs \{[^}]*order: 2;[^}]*height: var\(--phone-tabs-h\)/);
    expect(phone).toMatch(/\.an-tab\[data-pane="coach"\]:not\(\[hidden\]\) \{ display: block; \}/);
    // The score sheet is a pane, not dropped.
    expect(phone).toMatch(/\.moves-pane > \.moves-grid \{ max-height: none;/);
  });

  it("keeps every pane and the coach on the phone gutter", () => {
    expect(phone).toMatch(/\.an-pane \{[^}]*padding: 8px var\(--phone-gutter\)/);
    expect(phone).toMatch(/#analysis-explain \{[^}]*padding: \d+px var\(--phone-gutter\)/);
  });

  it("keeps Analyze in the thumb bar whichever pillar is open", () => {
    expect(phone).toMatch(/#view-analyze:not\(\[data-pane="coach"\]\) #analysis-explain \.cc-head > :not\(#analyze-actions\) \{ display: none; \}/);
  });

  it("paints the Humans picks at their words' height with a full thumb target", () => {
    expect(phone).toMatch(/#analysis-explain \.hp \{ position: relative; flex-shrink: 0; height: 28px;/);
    expect(phone).toMatch(/#analysis-explain \.hp::after \{[^}]*inset: -8px 0;/);
    // A 32px row: five picks fit across 390px and the verdict keeps three lines.
    expect(phone).toMatch(/#analysis-explain \.coach-maia \{[^}]*height: 32px/);
  });

  // The graph beside the figure is the same win-chance series: no meter.
  it("does not repeat the graph's win share in the band", () => {
    expect(phone).toMatch(/#analysis-eval-card \.ev-meter \{ display: none; \}/);
  });
});
