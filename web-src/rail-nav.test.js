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

describe("rail collapse after navigation", () => {
  it("collapses the hover overlay after a pointer click on a destination", () => {
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

  it("gates every hover-expansion rule on the collapse class", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.rail:hover/);
    expect(css).toContain(".rail:not(.is-nav-collapsed):hover");
  });

  it("names every collapsed rail destination for assistive tech and tooltips", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const rail = html.slice(html.indexOf('<nav class="rail"'), html.indexOf("</nav>"));
    const tabs = [...rail.matchAll(/<button class="tab nav-item[^>]*>[\s\S]*?<span class="nav-label">([^<]+)<\/span>/g)];
    expect(tabs.length).toBe(8);
    for (const [markup, label] of tabs) {
      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain(`title="${label}"`);
    }
  });
});
