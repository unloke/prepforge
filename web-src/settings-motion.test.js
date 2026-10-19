import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const phone = readFileSync(new URL("./phone.css", import.meta.url), "utf8");
const settings = readFileSync(new URL("./views/settings.css", import.meta.url), "utf8");

describe("settings motion", () => {
  it("arranges the six cards in reading order with a 60ms step", () => {
    expect(settings).toContain("#view-settings.is-active .settings-content > .set {");
    expect(settings).toMatch(/#view-settings\.is-active \.settings-content > \.set \{[^}]*animation:\s*view-enter/);
    const delays = [...settings.matchAll(/\.settings-content > \.set:nth-child\((\d)\) \{ animation-delay: (\d+)ms; \}/g)].map(
      (m) => [Number(m[1]), Number(m[2])],
    );
    expect(delays).toHaveLength(6);
    expect(delays.map((d) => d[0])).toEqual([1, 2, 3, 4, 5, 6]);
    // A fixed step, so the cards arrive at the same speed every time. The
    // first card waits for the title to land.
    expect(delays.map((d) => d[1])).toEqual([60, 120, 180, 240, 300, 360]);
  });

  it("plays the entrance again every time the page is opened", () => {
    // The animation hangs off the active view: when the view loses .is-active
    // the animation is dropped and starts again on the next visit.
    expect(settings).toMatch(/#view-settings\.is-active \.settings-content > \.set \{[^}]*animation:/);
    expect(css).toMatch(/\.view\.is-active \{[^}]*animation:\s*view-enter/);
  });

  it("keeps the entrance to opacity and travel", () => {
    const frames = /@keyframes view-enter \{([\s\S]*?)\n\}/.exec(css)[1];
    expect(frames).not.toMatch(/width|height|top:|left:|margin|padding/);
    // A reduced-motion reader gets the content without the travel.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation-duration: 0\.001ms !important/);
  });

  it("gives every settings control press feedback", () => {
    for (const selector of [".settings-nav-link:active", ".conn-menu-btn:active"]) {
      expect(settings).toContain(`${selector} {`);
    }
    expect(settings).toMatch(/\.conn-menu-item \{[^}]*transition:/);
  });

  it("opens the connection menu with a fade instead of a jump", () => {
    expect(settings).toMatch(/\.conn-menu \{[^}]*transition:\s*opacity[^}]*translate/);
    expect(settings).toMatch(/@starting-style \{\s*\.conn-menu:not\(\[hidden\]\) \{[^}]*opacity: 0;/);
  });

  it("draws the danger zone marker and turns it when the zone opens", () => {
    expect(settings).toContain(".acct-danger-zone > summary::-webkit-details-marker { display: none; }");
    expect(settings).toMatch(/\.acct-danger-zone > summary::before \{[^}]*border-left: 5px solid currentColor/);
    expect(settings).toMatch(/\.acct-danger-zone\[open\] > summary::before \{ transform: rotate\(90deg\); \}/);
  });

  it("presses the switch knob without losing its slide", () => {
    // scale is its own property, so it rides on top of the translateX.
    expect(css).toMatch(/\.pf-switch:active \.pf-knob \{\s*scale: 0\.9;/);
    expect(css).toMatch(/\.pf-knob \{[^}]*transition:[^}]*scale/);
  });

  it("sets the page title at the same size on every width", () => {
    // The phone header sets 32px for every page, so the desktop title keeps
    // the same size: one type size for the title at every width.
    const desktop = parseFloat(
      /#view-settings \.page-head h1 \{[^}]*font-size:\s*([\d.]+)px/.exec(settings)[1],
    );
    const phoneSize = parseFloat(/\.page-head h1 \{[^}]*font-size:\s*([\d.]+)px/.exec(phone)[1]);
    expect(desktop).toBe(phoneSize);
  });
});
