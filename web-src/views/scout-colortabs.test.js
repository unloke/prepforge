import { describe, expect, it } from "vitest";

import {
  applyScoutColorTabs,
  handleScoutColorTabClick,
  handleScoutColorTabKeydown,
  renderScoutColorTabsHtml,
} from "../scout-report.js";

// Characterization for the ui-prototype-v2 "With White / With Black" tabs on
// Scout: tabs come from the opponent profile's real per-colour game counts, the
// switch is visibility-only (sections keep their computed line state), and the
// active colour survives re-renders via the results element's dataset.



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
    focused: false,
  };
  t.classList = { toggle: (cls, on) => (on ? t.classes.add(cls) : t.classes.delete(cls)) };
  t.setAttribute = (k, v) => {
    t.attrs[k] = v;
  };
  t.focus = () => {
    t.focused = true;
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
    const html = renderScoutColorTabsHtml(profile);
    expect(String(html)).toContain('data-scout-tab="white"');
    expect(String(html)).toContain('data-scout-tab="black"');
    expect(String(html)).toContain("With White");
    expect(String(html)).toContain("With Black");
    expect(String(html)).toContain("312 games");
    expect(String(html)).toContain("287 games");
  });

  it("initial HTML selects exactly one tab and applies roving tabindex", () => {
    const html = renderScoutColorTabsHtml(profile);
    // Exactly one aria-selected="true" in the served markup.
    expect(String(html).match(/aria-selected="true"/g) || []).toHaveLength(1);
    // Roving tabindex: only the active tab is tabbable (no tabindex attr = 0).
    expect(String(html)).toContain('data-scout-tab="white" aria-selected="true" aria-controls=');
    expect(String(html)).toContain('data-scout-tab="black" aria-selected="false" tabindex="-1"');
    // Single-colour history: the lone tab is selected and tabbable.
    const solo = renderScoutColorTabsHtml(
      { colorStats: { white: { games: 0 }, black: { games: 5 } } },
    );
    expect(String(solo).match(/aria-selected="true"/g) || []).toHaveLength(1);
    expect(String(solo)).not.toContain('tabindex="-1"');
  });

  it("applyScoutColorTabs keeps roving tabindex in sync with selection", () => {
    const whiteTab = makeTab("white");
    const blackTab = makeTab("black");
    const el = makeResultsEl({
      tabs: [whiteTab, blackTab],
      sections: [makeSection("white"), makeSection("black")],
    });
    el.dataset.scoutTab = "black";
    applyScoutColorTabs(el);
    expect(blackTab.attrs["aria-selected"]).toBe("true");
    expect(blackTab.tabIndex).toBe(0);
    expect(whiteTab.attrs["aria-selected"]).toBe("false");
    expect(whiteTab.tabIndex).toBe(-1);
  });

  it("renders the streaming variant hidden and honours single-colour histories", () => {
    const hidden = renderScoutColorTabsHtml(profile, { hidden: true });
    expect(String(hidden)).toContain(" hidden>");
    const onlyBlack = renderScoutColorTabsHtml(
      { colorStats: { white: { games: 0 }, black: { games: 5 } } },
    );
    expect(String(onlyBlack)).toContain('data-scout-tab="black"');
    expect(String(onlyBlack)).not.toContain('data-scout-tab="white"');
    // No data at all → no bar (the stacked sections stay as-is).
    expect(String(renderScoutColorTabsHtml(null))).toBe("");
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

  it("ArrowRight/ArrowLeft move focus and activate — still visibility-only", () => {
    const whiteTab = makeTab("white");
    const blackTab = makeTab("black");
    const whiteSection = makeSection("white");
    const blackSection = makeSection("black");
    const el = makeResultsEl({
      tabs: [whiteTab, blackTab],
      sections: [whiteSection, blackSection],
    });
    applyScoutColorTabs(el);

    const key = (k, target) => ({
      key: k,
      target,
      preventDefault: () => {},
    });
    expect(handleScoutColorTabKeydown(key("ArrowRight", whiteTab), el)).toBe(true);
    expect(el.dataset.scoutTab).toBe("black");
    expect(blackTab.classes.has("is-active")).toBe(true);
    expect(blackTab.attrs["aria-selected"]).toBe("true");
    expect(blackSection.hidden).toBe(false);
    expect(whiteSection.hidden).toBe(true);
    expect(blackTab.focused).toBe(true);

    // Sections keep their computed state — the switch only toggles `hidden`.
    whiteSection.marker = "kept";
    expect(handleScoutColorTabKeydown(key("ArrowLeft", blackTab), el)).toBe(true);
    expect(el.dataset.scoutTab).toBe("white");
    expect(whiteSection.hidden).toBe(false);
    expect(whiteSection.marker).toBe("kept");
    expect(whiteTab.focused).toBe(true);
  });

  it("arrow navigation wraps and ignores unrelated keys and targets", () => {
    const whiteTab = makeTab("white");
    const blackTab = makeTab("black");
    const el = makeResultsEl({
      tabs: [whiteTab, blackTab],
      sections: [makeSection("white"), makeSection("black")],
    });

    // Right on the last tab wraps to the first.
    expect(
      handleScoutColorTabKeydown(
        { key: "ArrowRight", target: blackTab, preventDefault: () => {} },
        el,
      ),
    ).toBe(true);
    expect(el.dataset.scoutTab).toBe("white");
    // Left on the first tab wraps to the last.
    expect(
      handleScoutColorTabKeydown(
        { key: "ArrowLeft", target: whiteTab, preventDefault: () => {} },
        el,
      ),
    ).toBe(true);
    expect(el.dataset.scoutTab).toBe("black");

    // Non-arrow keys and non-tab targets fall through to the normal handlers.
    expect(
      handleScoutColorTabKeydown(
        { key: "Enter", target: whiteTab, preventDefault: () => {} },
        el,
      ),
    ).toBe(false);
    expect(
      handleScoutColorTabKeydown(
        { key: "ArrowRight", target: { closest: () => null }, preventDefault: () => {} },
        el,
      ),
    ).toBe(false);
  });

  it("Home/End jump to the first/last tab with activation and focus", () => {
    const whiteTab = makeTab("white");
    const blackTab = makeTab("black");
    const whiteSection = makeSection("white");
    const blackSection = makeSection("black");
    const el = makeResultsEl({
      tabs: [whiteTab, blackTab],
      sections: [whiteSection, blackSection],
    });
    el.dataset.scoutTab = "black";
    applyScoutColorTabs(el);

    expect(
      handleScoutColorTabKeydown(
        { key: "Home", target: blackTab, preventDefault: () => {} },
        el,
      ),
    ).toBe(true);
    expect(el.dataset.scoutTab).toBe("white");
    expect(whiteTab.focused).toBe(true);
    expect(whiteSection.hidden).toBe(false);

    expect(
      handleScoutColorTabKeydown(
        { key: "End", target: whiteTab, preventDefault: () => {} },
        el,
      ),
    ).toBe(true);
    expect(el.dataset.scoutTab).toBe("black");
    expect(blackTab.focused).toBe(true);
    expect(blackSection.hidden).toBe(false);
  });
});

// Regression: the colour tabs inlined the "- you have <Colour>" clause into the
// visible label. .scout-color-tabs is a nowrap flex row, so two ~246px tabs
// pushed the page to 503px at a 390px viewport (smoke: mobile-390 horizontal
// overflow of 113px). The wording must stay in the title / accessible name.
describe("scout colour tab label width", () => {
  it("keeps the visible label short but retains the colour context accessibly", () => {
    const html = renderScoutColorTabsHtml(profile, { username: "scouttarget" });
    expect(String(html)).toContain("<small>312 games</small>");
    expect(String(html)).toContain("<small>287 games</small>");
    expect(String(html)).not.toContain("games &middot;");
    expect(String(html)).not.toContain("games ·");
    // The wording itself is preserved in the tooltip and the accessible name.
    expect(String(html)).toContain("you have Black");
    expect(String(html)).toContain("you have White");
    expect(String(html)).toContain(
      'title="scouttarget with White: 312 games; in these games you have Black"',
    );
    expect(String(html)).toContain(
      'aria-label="scouttarget with Black: 287 games; in these games you have White"',
    );
  });
});
