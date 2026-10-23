import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const phone = readFileSync(new URL("./phone.css", import.meta.url), "utf8");
const settings = readFileSync(new URL("./views/settings.css", import.meta.url), "utf8");

describe("settings motion", () => {
  it("arrives with the view's own fade and nothing stacked on it", () => {
    // A second rise on the title, the strip and each card read as the page
    // loading twice; only the view's cross-fade plays on a visit.
    expect(settings).not.toMatch(/#view-settings\.is-active [^{]*\{[^}]*animation:/);
    expect(css).toMatch(/::view-transition-new\(view\) \{[^}]*animation:\s*view-enter/);
  });

  it("lands a jump on its card with a ring that fades, and keeps the ring still for reduced motion", () => {
    expect(settings).toMatch(/\.set\.is-landed::after \{[^}]*box-shadow: inset 0 0 0 2px var\(--accent\)[^}]*animation: set-land/);
    const frames = /@keyframes set-land \{([\s\S]*?)\n\}/.exec(settings)[1];
    expect(frames).not.toMatch(/transform|width|height|top|left/);
    expect(settings).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.settings-content > \.set\.is-landed::after \{ animation: none; opacity: 1; \}/);
  });

  it("keeps the entrance to opacity and travel", () => {
    const frames = /@keyframes view-enter \{([\s\S]*?)\n\}/.exec(css)[1];
    expect(frames).not.toMatch(/width|height|top:|left:|margin|padding/);
    // A reduced-motion reader gets the content without the travel.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation-duration: 0\.001ms !important/);
  });

  it("gives every settings control press feedback", () => {
    expect(settings).toContain(".settings-nav-link:active {");
    // The account menu opener is the shared quiet icon button, so it takes the
    // .btn press, hover and focus states instead of its own copy of them.
    const js = readFileSync(new URL("./views/settings.js", import.meta.url), "utf8");
    expect(js).toContain('class="btn ghost icon sm conn-menu-btn"');
    expect(settings).toMatch(/\.conn-menu-item \{[^}]*transition:/);
  });

  it("opens the connection menu with a fade instead of a jump", () => {
    expect(settings).toMatch(/\.conn-menu \{[^}]*transition:\s*opacity[^}]*translate/);
    expect(settings).toMatch(/@starting-style \{\s*\.conn-menu:popover-open \{[^}]*opacity: 0;/);
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

  it("takes the shell's one page-title rule, like every other view", () => {
    // The header is one rule for all views (26px desktop, 22px phone); Settings
    // used to carry a 32/800 copy of its own, which made its header taller than
    // Library's and Games'.
    const desktop = parseFloat(
      /\.workspace \.page-head h1 \{[^}]*font-size:\s*([\d.]+)px/.exec(css)[1],
    );
    const phoneSize = parseFloat(/\.page-head h1 \{[^}]*font-size:\s*([\d.]+)px/.exec(phone)[1]);
    expect(desktop).toBe(26);
    expect(settings).not.toMatch(/#view-settings \.page-head h1/);
    expect(phoneSize).toBeLessThanOrEqual(22);
  });
});
