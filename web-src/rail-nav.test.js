import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { RAIL_COLLAPSED_CLASS, bindRailCollapseOnNavigate } from "./rail-nav.js";

function fakeRail() {
  const listeners = {};
  const classes = new Set();
  return {
    classes,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    fire(type, event = {}) { for (const fn of listeners[type] || []) fn(event); },
  };
}

const target = (matches) => ({ closest: (sel) => (sel === ".tab[data-view]" && matches ? {} : null) });

describe("rail navigation class", () => {
  it("adds the collapse class after a pointer click on a destination", () => {
    const rail = fakeRail();
    bindRailCollapseOnNavigate(rail);
    rail.fire("click", { detail: 1, target: target(true) });
    expect(rail.classList.contains(RAIL_COLLAPSED_CLASS)).toBe(true);
    rail.fire("pointerleave");
    expect(rail.classList.contains(RAIL_COLLAPSED_CLASS)).toBe(false);
  });

  it("keeps the rail open for keyboard activation and non-destination buttons", () => {
    const rail = fakeRail();
    bindRailCollapseOnNavigate(rail);
    rail.fire("click", { detail: 0, target: target(true) });
    rail.fire("click", { detail: 1, target: target(false) });
    expect(rail.classList.contains(RAIL_COLLAPSED_CLASS)).toBe(false);
  });
});

describe("the desktop icon rail", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const rail = html.slice(html.indexOf('<nav class="rail"'), html.indexOf("</nav>"));

  it("stays an icon rail: it never widens on hover or focus", () => {
    // The rail used to grow to a 204px labelled overlay on hover; the sheet's
    // icon rail keeps its 60px track and names each icon in a tooltip instead.
    expect(css).not.toContain("--rail-open");
    expect(css).not.toMatch(/\.rail:not\(\.is-nav-collapsed\):hover\s*\{[^}]*width:/s);
    expect(css).toMatch(/\.rail\s*\{[^}]*width:\s*60px/s);
  });

  it("shows the name and job as a tooltip on hover and keyboard focus", () => {
    const tip = /\.rail :is\(\.tab, \.rail-btn\)::before \{([^}]+)\}/.exec(css)?.[1] || "";
    expect(tip).toMatch(/content:\s*attr\(aria-label\)/);
    expect(tip).toMatch(/position:\s*fixed/);
    expect(css).toMatch(/\.rail :is\(\.tab, \.rail-btn\):is\(:hover, :focus-visible\)::before\s*\{[^}]*opacity:\s*1/);
  });

  it("marks the open destination with the accent line, not a filled tile", () => {
    expect(css).toMatch(/\.rail \.tab\.is-active::after\s*\{[^}]*background:\s*var\(--accent\)/);
    expect(css).not.toMatch(/\.tab\.is-active\s*\{[^}]*background:\s*var\(--surface-3\)/);
  });

  it("names every destination for assistive tech and its tooltip", () => {
    const tabs = [...rail.matchAll(/<button class="tab nav-item[^>]*>[\s\S]*?<span class="nav-label">([^<]+)<\/span>/g)];
    expect(tabs.length).toBe(8);
    for (const [markup, label] of tabs) {
      // The accessible name is also the tooltip text (the `::before` reads
      // aria-label), so every icon carries the destination's name and job.
      expect(markup).toMatch(new RegExp(`aria-label="${label}( — [^"]+)?"`));
      expect(markup).not.toContain("title=");
    }
    expect(rail).toContain('aria-label="Games — review my games"');
    expect(rail).toContain('aria-label="Scout — prep against an opponent"');
  });
});
