import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ENTER, enterOnce, enterRows, reveal, settleEntrances } from "./list-enter.js";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function fakeEl({ key = "", skeleton = false, rendered = true, viewEntering = false } = {}) {
  const classes = new Set(skeleton ? ["is-skeleton"] : []);
  const props = {};
  return {
    hidden: false,
    dataset: { key },
    textContent: key,
    offsetWidth: 1,
    style: { setProperty: (name, value) => { props[name] = value; } },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    getClientRects: () => (rendered ? [{}] : []),
    closest: () => ({ getAnimations: () => (viewEntering ? [{ animationName: "view-enter", playState: "running" }] : []) }),
    props,
  };
}
function list(keys, opts = {}) {
  const container = fakeEl(opts);
  container.children = keys.map((key) => fakeEl({ key, skeleton: key === "~" }));
  return container;
}
const entering = (container) => container.children.filter((row) => row.classList.contains(ENTER)).map((row) => row.dataset.key);

describe("entrances", () => {
  it("numbers the arriving rows and caps the stagger so a long list never drags", () => {
    const container = list(Array.from({ length: 40 }, (_, i) => `r${i}`));
    enterRows(container);
    expect(container.children[0].props["--i"]).toBe("0");
    expect(container.children[8].props["--i"]).toBe("8");
    expect(container.children[39].props["--i"]).toBe("8");
  });

  it("a repaint enters only the rows that were not on screen", () => {
    const container = list(["a", "b"]);
    enterRows(container);
    container.children.forEach((row) => row.classList.remove(ENTER));
    // The refetch rewrites the list with the same rows plus one.
    container.children = ["a", "b", "c"].map((key) => fakeEl({ key }));
    enterRows(container);
    expect(entering(container)).toEqual(["c"]);
    // The newcomer is the first to wait its turn, not the third.
    expect(container.children[2].props["--i"]).toBe("0");
  });

  it("skeletons never enter, and a skeleton paint does not forget what was shown", () => {
    const container = list(["a", "b"]);
    enterRows(container);
    container.children = [fakeEl({ key: "~", skeleton: true }), fakeEl({ key: "~", skeleton: true })];
    enterRows(container);
    expect(entering(container)).toEqual([]);
    container.children = ["a", "b"].map((key) => fakeEl({ key }));
    enterRows(container);
    expect(entering(container)).toEqual([]);
  });

  it("content painted while the view fades in, or into a hidden view, rides that fade", () => {
    const fading = list(["a"], { viewEntering: true });
    enterRows(fading);
    expect(entering(fading)).toEqual([]);
    const hidden = list(["a"], { rendered: false });
    enterRows(hidden);
    expect(entering(hidden)).toEqual([]);
    const card = fakeEl({ viewEntering: true });
    enterOnce(card);
    expect(card.classList.contains(ENTER)).toBe(false);
  });

  it("reveal enters a hidden element once; showing it again is a repaint", () => {
    const card = fakeEl();
    card.hidden = true;
    reveal(card);
    expect(card.hidden).toBe(false);
    expect(card.classList.contains(ENTER)).toBe(true);
    card.classList.remove(ENTER);
    reveal(card);
    expect(card.classList.contains(ENTER)).toBe(false);
  });

  it("the marker comes off when the entrance ends or is cut short", () => {
    const handlers = {};
    settleEntrances({ addEventListener: (type, fn) => { handlers[type] = fn; } });
    for (const type of ["animationend", "animationcancel"]) {
      const row = fakeEl();
      row.classList.add(ENTER);
      handlers[type]({ target: row });
      expect(row.classList.contains(ENTER)).toBe(false);
    }
  });

  it("nothing in a list animates without the marker, and only opacity and travel move", () => {
    expect(css).not.toMatch(/\.list-enter > \* \{/);
    const body = /\.list-enter > \.is-enter \{([^}]*)\}/.exec(css)[1];
    expect(body).toContain("animation: row-enter");
    expect(body).toContain("calc(min(var(--i, 0), 8) * var(--stagger, 25ms))");
    const frames = /@keyframes row-enter \{([\s\S]*?)\n\}/.exec(css)[1];
    expect(frames).not.toMatch(/width|height|top:|left:|margin|padding/);
  });

  it("every one-shot entrance hangs off the marker, so re-showing a view cannot replay it", () => {
    // `:not([hidden])` and bare-class entrances restart whenever an ancestor
    // goes from display:none to shown — the "it animates twice" report.
    expect(css).not.toMatch(/:not\(\[hidden\]\) \{ animation:/);
    for (const selector of ["#build-branchbar.is-enter", "#train-summary.is-enter", "#train-progress-panel.is-enter", "#view-dashboard .today.is-enter", "#explorer-rows > .is-enter"]) {
      expect(css).toContain(selector);
    }
  });

  it("gives every pressable control the same scale-down", () => {
    for (const selector of [".mtree-move:active", ".row-menu-btn:active", ".sum-chip:active", ".tabbar-item:active"]) {
      expect(css).toContain(`${selector} {`);
    }
  });
});
