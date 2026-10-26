// Analyze on a phone, round 2 (composition): the board, a one-line move strip
// under it, the open pane, 44px pane tabs and the thumb bar. The grading switch
// leaves the coach's head row (the review bar's line there) for the engine
// pane's head on a phone, and comes back on a wider screen.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const css = readFileSync(new URL("./analyze-chart.css", import.meta.url), "utf8");
const phoneR2 = css.slice(css.indexOf("/* ---- Phone, round 2: composition"));

// A small element tree: enough of the DOM for installAnalyzePanes.
class El {
  constructor(id = "", cls = "") {
    this.id = id;
    this.classList = new Set(cls.split(" ").filter(Boolean));
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
  }
  add(...kids) {
    for (const k of kids) {
      k.parentElement?.children.splice(k.parentElement.children.indexOf(k), 1);
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
  append(...kids) { this.add(...kids); }
  before(...nodes) {
    const p = this.parentElement;
    for (const n of nodes) {
      n.parentElement?.children.splice(n.parentElement.children.indexOf(n), 1);
      n.parentElement = p;
      p.children.splice(p.children.indexOf(this), 0, n);
    }
  }
  after(node) {
    const p = this.parentElement;
    node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1);
    node.parentElement = p;
    p.children.splice(p.children.indexOf(this) + 1, 0, node);
  }
  get previousElementSibling() { const s = this.parentElement?.children; return s ? s[s.indexOf(this) - 1] || null : null; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  matches(sel) { return sel.startsWith("#") ? this.id === sel.slice(1) : sel.startsWith(".") ? this.classList.has(sel.slice(1)) : sel === "[role=tab]" && this.attrs.role === "tab"; }
  querySelector(sel) { const last = sel.split(" ").pop(); return this.all().find((e) => e.matches(last)) || null; }
  querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel)); }
  contains(node) { return node === this || this.all().includes(node); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
}

function analyzeView() {
  const view = new El("view-analyze");
  const boardArea = new El("", "board-area").add(new El("", "board-bar"));
  const tabs = new El("analyze-tabs");
  for (const p of ["coach", "engine", "report"]) { const t = new El(`an-tab-${p}`); t.attrs.role = "tab"; t.dataset.pane = p; tabs.add(t); }
  const label = new El("explain-engine-label");
  const toggle = new El("explain-engine-toggle");
  const actions = new El("analyze-actions");
  const coach = new El("analysis-explain").add(new El("", "cc-head").add(label, toggle, actions));
  const engineHead = new El("", "an-pane-head").add(new El("open-engine-widget"));
  const engine = new El("analysis-engine-pane").add(engineHead);
  const main = new El("analyze-main").add(coach, new El("analysis-eval-card"), new El("analyze-panes").add(tabs, engine));
  view.add(boardArea, main);
  return { view, label, toggle, actions, engineHead };
}

function install(phone) {
  const dom = analyzeView();
  const listeners = [];
  globalThis.document = { getElementById: (id) => (dom.view.id === id ? dom.view : dom.view.all().find((e) => e.id === id) || null), querySelector: (sel) => dom.view.querySelector(sel) };
  globalThis.window = { matchMedia: (q) => ({ get matches() { return phone.value && q === "(max-width: 760px)"; }, addEventListener: (_, fn) => listeners.push(fn) }) };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  return { dom, relayout: () => listeners.forEach((fn) => fn()) };
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.localStorage;
});

describe("Analyze phone, round 2", () => {
  it("moves the grading switch to the engine pane's head on a phone and back on a wider screen", async () => {
    const { installAnalyzePanes } = await import("./analyze-panes.js");
    const phone = { value: true };
    const { dom, relayout } = install(phone);
    installAnalyzePanes();
    expect(dom.engineHead.children.map((c) => c.id)).toEqual(["open-engine-widget", "explain-engine-label", "explain-engine-toggle"]);
    phone.value = false;
    relayout();
    expect(dom.actions.parentElement.children.map((c) => c.id)).toEqual(["explain-engine-label", "explain-engine-toggle", "analyze-actions"]);
    expect(dom.engineHead.contains(dom.toggle)).toBe(false);
  });

  it("shows the game as a one-line move strip under the board, not a tab", () => {
    expect(phoneR2).toMatch(/#view-analyze:has\(#analysis-results:not\(\[hidden\]\)\) \.an-panes \{ display: contents; \}/);
    expect(phoneR2).toMatch(/#view-analyze #analysis-results\.moves-pane:not\(\[hidden\]\) \{[^}]*order: 2;[^}]*height: var\(--phone-strip-h\);/);
    expect(phoneR2).toMatch(/\.mtree-line\.is-main \{[^}]*flex-wrap: nowrap;/);
    expect(phoneR2).toMatch(/#analysis-moves \{[^}]*overflow-x: auto;/);
    // Every move in the strip is a 44px target.
    expect(phoneR2).toMatch(/#analysis-moves \.mtree-move \{[^}]*min-width: 44px;[^}]*height: 44px;/);
  });

  it("gives every pane tab the whole 44px track", () => {
    expect(phoneR2).toMatch(/\.an-panes > \.an-tabs \{ height: 44px; padding: 0;/);
    expect(phoneR2).toMatch(/#view-analyze \.an-tab \{ height: 44px;/);
    expect(phoneR2).toMatch(/#view-analyze \.an-tab::after \{ content: none; \}/);
  });

  it("never wraps a key moment's better move beside its eval", () => {
    expect(phoneR2).toMatch(/#view-analyze \.km \{[^}]*display: grid;/);
    expect(phoneR2).not.toMatch(/\.km \{[^}]*flex-wrap: wrap/);
  });
});
