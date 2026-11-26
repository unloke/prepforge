import { describe, expect, it, vi } from "vitest";

import { applyScoutColorTabs } from "../scout-report.js";
import { captureScoutViewState, restoreScoutViewState, scoutPrefilterFailedNoteHtml } from "./scout-render-state.js";

// A small element tree: enough selector support (tag, .class, #id, [attr],
// [attr="v"], descendant, comma lists) for what the Scout helpers query.
function matchesCompound(el, compound) {
  const parts = compound.match(/[a-z]+|\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) || [];
  return parts.every((part) => {
    if (part.startsWith(".")) return el.classes.includes(part.slice(1));
    if (part.startsWith("#")) return el.id === part.slice(1);
    if (part.startsWith("[")) {
      const [, name, value] = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!(name in el.attrs)) return false;
      return value == null || el.attrs[name] === value;
    }
    return el.tagName === part.toUpperCase();
  });
}
function matches(el, selector) {
  return selector.split(",").some((sel) => {
    const chain = sel.trim().split(/\s+/);
    if (!matchesCompound(el, chain.at(-1))) return false;
    let node = el.parent;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (node && !matchesCompound(node, chain[i])) node = node.parent;
      if (!node) return false;
      node = node.parent;
    }
    return true;
  });
}
function el(tag, attrs = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(), attrs, children, parent: null,
    get id() { return attrs.id || ""; },
    get classes() { return (attrs.class || "").split(" ").filter(Boolean); },
    get className() { return attrs.class || ""; },
    get dataset() {
      return Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith("data-"))
        .map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v]));
    },
    focus: vi.fn(),
    descendants() { return children.flatMap((c) => [c, ...c.descendants()]); },
    querySelectorAll(sel) { return node.descendants().filter((d) => matches(d, sel)); },
    closest(sel) { for (let n = node; n; n = n.parent) if (matches(n, sel)) return n; return null; },
    contains(other) { for (let n = other; n; n = n.parent) if (n === node) return true; return false; },
  };
  for (const c of children) c.parent = node;
  return node;
}

function report({ drilled = false } = {}) {
  const firstMoves = el("div", { "data-dist-root": "true", ...(drilled ? { "data-drill-uci": "e2e4" } : {}) }, [
    el("div", { class: "scout-dist-row", "data-first-uci": "e2e4", tabindex: "0" }),
    el("div", { class: "scout-dist-row", "data-first-uci": "d2d4", tabindex: "0" }),
  ]);
  const row = (key) => el("div", { class: "scout-line", "data-line-key": key, "data-color": "white" }, [
    el("div", { class: "scout-line-toggle", tabindex: "0" }),
    el("button", { class: "scout-add-prep btn" }),
  ]);
  return el("div", { id: "scout-results" }, [
    el("div", { class: "scout-section", "data-scout-color": "white", id: "scout-section-white" }, [firstMoves, row("e4 c5"), row("d4 d5")]),
  ]);
}

describe("scout view state across a report rebuild", () => {
  it("puts focus back on the same control of the same line", () => {
    const before = report();
    const add = before.querySelectorAll(".scout-line")[1].querySelectorAll("button")[0];
    const kept = captureScoutViewState(before, add);

    const after = report();
    restoreScoutViewState(after, kept);
    const again = after.querySelectorAll(".scout-line")[1].querySelectorAll("button")[0];
    expect(again.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(after.querySelectorAll(".scout-line")[0].querySelectorAll("button")[0].focus).not.toHaveBeenCalled();
  });

  it("leaves focus alone when the line is gone or focus was outside the report", () => {
    const before = report();
    const toggle = before.querySelectorAll(".scout-line-toggle")[0];
    const kept = captureScoutViewState(before, toggle);
    const after = el("div", { id: "scout-results" }, []);
    expect(() => restoreScoutViewState(after, kept)).not.toThrow();
    expect(captureScoutViewState(report(), el("button")).focus).toBeNull();
  });

  it("redraws a drilled first move after the rebuild", () => {
    const kept = captureScoutViewState(report({ drilled: true }), null);
    expect(kept.drills).toEqual([{ color: "white", uci: "e2e4" }]);
    const after = report();
    const redrill = vi.fn();
    restoreScoutViewState(after, kept, { redrill });
    expect(redrill).toHaveBeenCalledTimes(1);
    const [row, section, color] = redrill.mock.calls[0];
    expect(row.dataset.firstUci).toBe("e2e4");
    expect(section.dataset.scoutColor).toBe("white");
    expect(color).toBe("white");
  });

  it("returns side-panel focus only to the same line's detail", () => {
    const side = (key) => el("aside", { id: "scout-side", "data-line-key": key }, [el("button", { class: "btn" })]);
    const before = side("e4 c5");
    const kept = captureScoutViewState(before, before.children[0]);
    const other = side("d4 d5");
    restoreScoutViewState(other, kept);
    expect(other.children[0].focus).not.toHaveBeenCalled();
    const same = side("e4 c5");
    restoreScoutViewState(same, kept);
    expect(same.children[0].focus).toHaveBeenCalled();
  });
});

describe("scout colour tabs", () => {
  it("a stored colour with no tab in this report falls back to the first tab", () => {
    // Was: the stored "black" matched no tab and every section was hidden.
    const tab = { dataset: { scoutTab: "white" }, classList: { toggle: vi.fn() }, setAttribute: vi.fn(), tabIndex: -1 };
    const section = { dataset: { scoutColor: "white" }, hidden: true };
    const results = {
      dataset: { scoutTab: "black" },
      querySelectorAll: (sel) => (sel.includes("tab") ? [tab] : [section]),
    };
    applyScoutColorTabs(results);
    expect(section.hidden).toBe(false);
    expect(tab.setAttribute).toHaveBeenCalledWith("aria-selected", "true");
  });
});

describe("scout prefilter failure note", () => {
  it("offers a retry only when the read failed", () => {
    expect(String(scoutPrefilterFailedNoteHtml(true))).toContain("data-scout-retry-prefilter");
    expect(String(scoutPrefilterFailedNoteHtml(false))).toBe("");
  });
});
