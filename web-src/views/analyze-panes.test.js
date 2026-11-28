import { afterEach, describe, expect, it, vi } from "vitest";

class El {
  constructor(id = "") {
    this.id = id;
    this.dataset = {};
    this.listeners = {};
    this.children = [];
    this.parentElement = null;
    this.attrs = {};
  }
  add(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  all() { return this.children.flatMap((child) => [child, ...child.all()]); }
  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector === ".panel-scroll") return this.panelScroll === true;
    if (selector === "[role=tab]") return this.attrs.role === "tab";
    return false;
  }
  querySelector(selector) { return this.all().find((el) => el.matches(selector)) || null; }
  querySelectorAll(selector) { return this.all().filter((el) => el.matches(selector)); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  scroll() { for (const fn of this.listeners.scroll || []) fn({ type: "scroll" }); }
}

function installFixture() {
  const view = new El("view-analyze");
  const tabs = new El("analyze-tabs");
  const report = new El("analysis-report");
  const scroller = new El();
  scroller.panelScroll = true;
  const sidebar = new El("analyze-sidebar").add(scroller);
  view.add(tabs, report, sidebar);
  globalThis.document = {
    getElementById: (id) => (view.id === id ? view : view.all().find((el) => el.id === id) || null),
    querySelector: (selector) => selector === "#analyze-sidebar > .panel-scroll" ? scroller : view.querySelector(selector),
  };
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener: () => {} }) };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  return { report, scroller };
}

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.localStorage;
});

describe("Analyze report scroll thumb", () => {
  it("marks only the two report scrollers while scrolling, then clears them", async () => {
    vi.useFakeTimers();
    const { report, scroller } = installFixture();
    const { installAnalyzePanes } = await import("./analyze-panes.js");
    installAnalyzePanes();
    installAnalyzePanes();
    expect(report.listeners.scroll).toHaveLength(1);
    expect(scroller.listeners.scroll).toHaveLength(1);

    report.scroll();
    expect(report.dataset.scrolling).toBe("");
    vi.advanceTimersByTime(649);
    expect(report.dataset.scrolling).toBe("");
    vi.advanceTimersByTime(1);
    expect(report.dataset.scrolling).toBeUndefined();

    scroller.scroll();
    expect(scroller.dataset.scrolling).toBe("");
    vi.advanceTimersByTime(400);
    scroller.scroll();
    vi.advanceTimersByTime(649);
    expect(scroller.dataset.scrolling).toBe("");
    vi.advanceTimersByTime(1);
    expect(scroller.dataset.scrolling).toBeUndefined();
  });
});
