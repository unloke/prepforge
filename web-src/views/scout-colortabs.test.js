import { describe, expect, it } from "vitest";

import {
  applyScoutColorTabs,
  handleScoutColorTabClick,
  renderScoutColorTabsHtml,
} from "../scout-report.js";

// Characterization for the ui-prototype-v2 "With White / With Black" tabs on
// Scout: tabs come from the opponent profile's real per-colour game counts, the
// switch is visibility-only (sections keep their computed line state), and the
// active colour survives re-renders via the results element's dataset.

const escapeHtml = (s) => String(s);

function makeResultsEl({ tabs, sections, active = null }) {
  const el = { dataset: active ? { scoutTab: active } : {} };
  el.querySelectorAll = (sel) => {
    if (sel === ".scout-color-tab") return tabs;
    if (sel === ".scout-section[data-scout-color]") return sections;
    return [];
  };
  el.contains = () => true;
  return el;
}

function makeTab(color) {
  const t = {
    dataset: { scoutTab: color },
    classes: new Set(),
    attrs: {},
  };
  t.classList = { toggle: (cls, on) => (on ? t.classes.add(cls) : t.classes.delete(cls)) };
  t.setAttribute = (k, v) => {
    t.attrs[k] = v;
  };
  // Real DOM elements carry closest(); the tab is its own match.
  t.closest = (sel) => (sel === ".scout-color-tab" ? t : null);
  return t;
}

function makeSection(color) {
  return { dataset: { scoutColor: color }, hidden: false };
}

const profile = {
  colorStats: {
    white: { games: 312, w: 150, d: 80, l: 82 },
    black: { games: 287, w: 120, d: 90, l: 77 },
  },
};

describe("scout colour tabs", () => {
  it("renders both tabs with real per-colour game counts", () => {
    const html = renderScoutColorTabsHtml(profile, escapeHtml);
    expect(html).toContain('data-scout-tab="white"');
    expect(html).toContain('data-scout-tab="black"');
    expect(html).toContain("With White");
    expect(html).toContain("With Black");
    expect(html).toContain("312 games");
    expect(html).toContain("287 games");
  });

  it("renders the streaming variant hidden and honours single-colour histories", () => {
    const hidden = renderScoutColorTabsHtml(profile, escapeHtml, { hidden: true });
    expect(hidden).toContain(" hidden>");
    const onlyBlack = renderScoutColorTabsHtml(
      { colorStats: { white: { games: 0 }, black: { games: 5 } } },
      escapeHtml,
    );
    expect(onlyBlack).toContain('data-scout-tab="black"');
    expect(onlyBlack).not.toContain('data-scout-tab="white"');
    // No data at all → no bar (the stacked sections stay as-is).
    expect(renderScoutColorTabsHtml(null, escapeHtml)).toBe("");
  });

  it("switches visibility only and defaults to the first tab", () => {
    const whiteTab = makeTab("white");
    const blackTab = makeTab("black");
    const whiteSection = makeSection("white");
    const blackSection = makeSection("black");
    const el = makeResultsEl({
      tabs: [whiteTab, blackTab],
      sections: [whiteSection, blackSection],
    });

    applyScoutColorTabs(el);
    // No stored state → first tab active, its section visible, the other hidden.
    expect(whiteTab.classes.has("is-active")).toBe(true);
    expect(blackSection.hidden).toBe(true);
    expect(whiteSection.hidden).toBe(false);

    // Stored state wins (re-render after filter changes keeps the colour).
    el.dataset.scoutTab = "black";
    applyScoutColorTabs(el);
    expect(blackTab.classes.has("is-active")).toBe(true);
    expect(blackTab.attrs["aria-selected"]).toBe("true");
    expect(whiteSection.hidden).toBe(true);
    expect(blackSection.hidden).toBe(false);
  });

  it("handles tab clicks and ignores unrelated targets", () => {
    const blackTab = makeTab("black");
    const whiteSection = makeSection("white");
    const blackSection = makeSection("black");
    const el = makeResultsEl({
      tabs: [makeTab("white"), blackTab],
      sections: [whiteSection, blackSection],
    });
    expect(handleScoutColorTabClick({ target: blackTab }, el)).toBe(true);
    expect(el.dataset.scoutTab).toBe("black");
    expect(blackSection.hidden).toBe(false);
    expect(whiteSection.hidden).toBe(true);

    // A click on a line row (no .scout-color-tab ancestor) falls through.
    expect(handleScoutColorTabClick({ target: { closest: () => null } }, el)).toBe(false);
  });
});
