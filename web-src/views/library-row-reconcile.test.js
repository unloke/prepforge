// The Library paints its list twice per load: first with the team names it
// already has, then with the fresh /api/repertoires listing. Both passes used
// to write the whole table, which replayed the row entrance over identical
// content and rebuilt the focused row — the "fades in, then fades in again"
// the user reported. A load must no longer do that:
//
//  - a row whose content is unchanged keeps its DOM node (no re-animation, no
//    lost focus, no scroll jump);
//  - only a row that arrives or whose cells changed is rebuilt, and it is the
//    only row that carries the entrance marker;
//  - order, filter, selection and the count still follow the listing.
//
// These tests run the real view against a minimal DOM built by the same
// document stub the filter tests use, so a rewrite of every row shows up as a
// replaced node here rather than as a second fade in the browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDashboardView } from "./dashboard.js";

// --- a small DOM ------------------------------------------------------------
// The row reconciliation only needs the container's top-level children, their
// dataset/classes, and insert/replace/remove. This parses the top-level
// elements out of a markup string (a tag scanner, not a full HTML parser) so a
// kept node and a replaced node are told apart by identity, which is exactly
// what the "the list fades in twice" regression is about.
class FakeNode {
  constructor(outerHtml = "") {
    this.tagName = "DIV";
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.hidden = false;
    this._classes = new Set();
    this._attrs = new Map();
    this._listeners = new Map();
    this.style = { setProperty: () => {}, removeProperty: () => {} };
    this._html = String(outerHtml);
    this._readAttributes();
    this.classList = {
      add: (...names) => names.forEach((n) => this._classes.add(n)),
      remove: (...names) => names.forEach((n) => this._classes.delete(n)),
      contains: (name) => this._classes.has(name),
      toggle: (name, on) => (on ? this._classes.add(name) : this._classes.delete(name)),
    };
  }

  _readAttributes() {
    const open = /^<[a-z]+\s([^>]*)>/i.exec(this._html);
    const attrs = open ? open[1] : "";
    const attr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const repId = attr("data-repertoire-id");
    if (repId != null) this.dataset.repertoireId = repId;
    if (attrs.includes('data-shared="1"')) this.dataset.shared = "1";
    const active = attr("data-active");
    if (active != null) this.dataset.active = active;
    for (const cls of (attr("class") || "").split(/\s+/).filter(Boolean)) this._classes.add(cls);
  }

  get ownerDocument() {
    return globalThis.document;
  }

  get className() {
    return [...this._classes].join(" ");
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(value) {
    this._html = String(value);
    this.children = parseTopLevel(String(value));
    this.children.forEach((child) => {
      child.parentNode = this;
    });
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get nextElementSibling() {
    const siblings = this.parentNode ? this.parentNode.children : [];
    const at = siblings.indexOf(this);
    return at < 0 ? null : siblings[at + 1] || null;
  }

  _detach() {
    const parent = this.parentNode;
    if (!parent) return -1;
    const at = parent.children.indexOf(this);
    if (at >= 0) parent.children.splice(at, 1);
    return at;
  }

  prepend(node) {
    node._detach();
    node.parentNode = this;
    this.children.unshift(node);
  }

  after(node) {
    const parent = this.parentNode;
    if (!parent) return;
    node._detach();
    node.parentNode = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
  }

  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    if (at < 0) return;
    node._detach();
    node.parentNode = parent;
    parent.children[at] = node;
    this.parentNode = null;
  }

  remove() {
    this._detach();
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this._attrs.get(name) ?? null;
  }

  removeAttribute(name) {
    this._attrs.delete(name);
  }

  addEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    list.push(fn);
    this._listeners.set(type, list);
  }

  focus() {
    globalThis.document.activeElement = this;
  }

  querySelector(selector) {
    if (selector !== ".row-menu-btn") return null;
    // The per-row menu button is the only child a listener is attached to; it
    // lives inside the row markup, so hand back a stub with the geometry the
    // context-menu call reads.
    if (!this._html.includes('class="row-menu-btn"')) return null;
    const btn = new FakeNode('<button class="row-menu-btn">x</button>');
    btn.getBoundingClientRect = () => ({ left: 0, bottom: 0 });
    btn.parentNode = this;
    return btn;
  }

  querySelectorAll(selector) {
    if (selector === ".lib-row") return this.children.filter((n) => n.classList.contains("lib-row"));
    if (selector === "[data-repertoire-id]") return this.children.filter((n) => n.dataset.repertoireId);
    return [];
  }

  closest() {
    return null;
  }
}

// Top-level elements of a markup string. Rows and empty states in this view are
// flat lists of elements, so counting only <div>/<span>/<button> nesting is
// enough; anything deeper stays inside its element's outerHTML.
const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);
function parseTopLevel(markup) {
  const nodes = [];
  let depth = 0;
  let start = -1;
  const tag = /<(\/?)([a-z0-9-]+)\b[^>]*?(\/?)>/gi;
  let match;
  while ((match = tag.exec(markup))) {
    const [whole, closing, name, selfClose] = match;
    if (closing) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        nodes.push(new FakeNode(markup.slice(start, tag.lastIndex)));
        start = -1;
      }
      continue;
    }
    if (VOID.has(name.toLowerCase()) || selfClose) {
      if (depth === 0) nodes.push(new FakeNode(whole));
      continue;
    }
    if (depth === 0) start = match.index;
    depth += 1;
  }
  return nodes;
}

function listTemplate() {
  const template = new FakeNode("<template></template>");
  const value = { content: { firstElementChild: null } };
  Object.defineProperty(template, "innerHTML", {
    set(markup) {
      // One root element per string, as a real <template> yields.
      template.content.firstElementChild = parseTopLevel(String(markup))[0] || null;
    },
    get() {
      return "";
    },
  });
  return Object.assign(template, value);
}

const REPS = (over = {}) => ({
  repertoires: [
    { id: "rep-1", name: "Caro-Kann: Advance", color: "black", is_active: true, visibility: "private", health: { trainable: 40, mastered: 20, weak: 6, due: 9, learning: 3, untrained: 2, mastery_pct: 50 }, ...(over.rep1 || {}) },
    { id: "rep-2", name: "London System", color: "white", is_active: true, visibility: "private", health: null, ...(over.rep2 || {}) },
  ],
  shared: over.shared || [],
});

describe("Library row reconciliation", () => {
  let container;
  let elements;
  let view;
  let payloads;

  function build() {
    let call = 0;
    view = createDashboardView({
      appState: { signedIn: true, teams: [], pendingRepDeletes: new Set() },
      api: vi.fn(async (url) => {
        if (String(url).startsWith("/api/teams")) return { teams: [] };
        return payloads[Math.min(call++, payloads.length - 1)];
      }),
      postJson: vi.fn(),
      setStatus: vi.fn(),
      localDateString: () => "2026-10-08",
      goToSmartTraining: vi.fn(),
      editRepertoire: vi.fn(),
      openRepertoireContextMenu: vi.fn(),
      createRepertoirePrompt: vi.fn(),
      hydrateBuild: vi.fn(),
      showInputModal: vi.fn(),
      promptImportRepertoireFromPgn: vi.fn(),
      requireSignIn: vi.fn(),
      goToView: vi.fn(),
    });
  }

  const rows = () => container.children.filter((n) => n.classList.contains("lib-row"));
  const ids = () => rows().map((r) => r.dataset.repertoireId);
  // What the browser does when a row's entrance finishes: the marker comes off,
  // so re-showing the view cannot replay it.
  const settle = () =>
    rows().forEach((row) =>
      (row._listeners.get("animationend") || []).forEach((fn) => fn({ animationName: "row-enter" })),
    );

  beforeEach(() => {
    container = new FakeNode("");
    const cols = new FakeNode("");
    const count = { hidden: true, textContent: "" };
    const card = {
      _classes: new Set(),
      classList: {
        toggle(name, on) {
          if (on) this._classes?.add?.(name);
        },
        add() {},
        remove() {},
        contains() {
          return false;
        },
      },
    };
    elements = new Map([
      ["dashboard-repertoires", container],
      ["dashboard-rep-count", count],
      ["lib-cols", cols],
    ]);
    globalThis.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: (sel) => (sel === "#view-dashboard .lib-list" ? card : null),
      querySelectorAll: () => [],
      createElement: (tag) => (tag === "template" ? listTemplate() : new FakeNode("")),
      activeElement: null,
    };
  });

  afterEach(() => {
    delete globalThis.document;
  });

  it("keeps every row node when the fresh listing says the same thing", async () => {
    // The second read is what the cached-then-fresh load really does: the same
    // rows twice. Replacing them is what replayed the entrance twice.
    payloads = [REPS(), REPS()];
    build();
    await view.loadDashboardRepertoires();
    const first = rows();
    expect(ids()).toEqual(["rep-1", "rep-2"]);

    await view.loadDashboardRepertoires();
    expect(rows()).toHaveLength(2);
    // Same objects, not equal markup: a kept row is the same node.
    expect(rows()[0]).toBe(first[0]);
    expect(rows()[1]).toBe(first[1]);
  });

  it("rebuilds only the row whose content changed, and only that one enters", async () => {
    payloads = [REPS(), REPS({ rep1: { health: { trainable: 40, mastered: 26, weak: 0, due: 0, learning: 0, untrained: 2, mastery_pct: 62 } } })];
    build();
    await view.loadDashboardRepertoires();
    settle();
    const [before1, before2] = rows();
    expect(before1.classList.contains("is-enter")).toBe(false);

    await view.loadDashboardRepertoires();
    const [after1, after2] = rows();
    expect(after1).not.toBe(before1); // its mastery bar changed
    expect(after2).toBe(before2); // untouched row keeps its node
    // Only the rebuilt row arrives, so only it draws the entrance.
    expect(after1.classList.contains("is-enter")).toBe(true);
    expect(after2.classList.contains("is-enter")).toBe(false);
  });

  it("marks an added row for entry and leaves the rows already on screen settled", async () => {
    const third = { id: "rep-3", name: "QGD vs 1.d4", color: "black", is_active: true, visibility: "private", health: null };
    payloads = [REPS(), { ...REPS(), repertoires: [...REPS().repertoires, third] }];
    build();
    await view.loadDashboardRepertoires();
    settle();
    const initial = rows();

    await view.loadDashboardRepertoires();
    expect(ids()).toEqual(["rep-1", "rep-2", "rep-3"]);
    // The rows already on screen keep their nodes and stay settled; the one
    // that arrived is the row that enters.
    expect(rows()[0]).toBe(initial[0]);
    expect(rows()[1]).toBe(initial[1]);
    expect(rows()[0].classList.contains("is-enter")).toBe(false);
    expect(rows()[1].classList.contains("is-enter")).toBe(false);
    expect(rows()[2].classList.contains("is-enter")).toBe(true);
  });

  it("removes a deleted repertoire's row and keeps the survivors", async () => {
    payloads = [REPS(), { ...REPS(), repertoires: [REPS().repertoires[1]] }];
    build();
    await view.loadDashboardRepertoires();
    const [, kept] = rows();

    await view.loadDashboardRepertoires();
    expect(ids()).toEqual(["rep-2"]);
    expect(rows()[0]).toBe(kept);
  });

  it("reorders without rebuilding: the nodes move, their content does not change", async () => {
    payloads = [REPS(), { ...REPS(), repertoires: [REPS().repertoires[1], REPS().repertoires[0]] }];
    build();
    await view.loadDashboardRepertoires();
    const [first, second] = rows();

    await view.loadDashboardRepertoires();
    expect(ids()).toEqual(["rep-2", "rep-1"]);
    expect(rows()[0]).toBe(second);
    expect(rows()[1]).toBe(first);
  });

  it("keeps the selected row selected through a refresh, in place", async () => {
    payloads = [REPS(), REPS()];
    build();
    await view.loadDashboardRepertoires();
    // The first row is selected by default; select the second the way a row
    // click does (selection is the row's own state, not the listing's).
    view.setLibraryFilter("white");
    const selected = rows();
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.repertoireId).toBe("rep-2");
    expect(selected[0].classList.contains("is-selected")).toBe(true);

    await view.loadDashboardRepertoires();
    expect(ids()).toEqual(["rep-2"]);
    expect(rows()[0]).toBe(selected[0]);
    expect(rows()[0].classList.contains("is-selected")).toBe(true);
  });

  it("a filtered table narrowed to nothing still offers the way back", async () => {
    payloads = [REPS(), REPS()];
    build();
    await view.loadDashboardRepertoires();
    view.setLibraryQuery("no such repertoire");
    expect(String(container.innerHTML)).toContain("No repertoires match this search.");
    view.setLibraryQuery("");
    expect(ids()).toEqual(["rep-1", "rep-2"]);
  });

  it("keeps shared read-only rows beside the own ones through a refresh", async () => {
    const withShare = { ...REPS(), shared: [{ id: "team-1", name: "Coach Sicilian", color: "black" }] };
    payloads = [withShare, withShare];
    build();
    await view.loadDashboardRepertoires();
    const first = rows();
    expect(ids()).toEqual(["rep-1", "rep-2", "team-1"]);
    expect(first[2].dataset.shared).toBe("1");

    await view.loadDashboardRepertoires();
    expect(ids()).toEqual(["rep-1", "rep-2", "team-1"]);
    expect(rows()[2]).toBe(first[2]);
  });

  it("an account change replaces the rows that do not survive the new owner", async () => {
    payloads = [
      REPS(),
      { repertoires: [{ id: "rep-9", name: "Another account", color: "white", is_active: true, visibility: "private", health: null }], shared: [] },
    ];
    build();
    await view.loadDashboardRepertoires();
    expect(ids()).toEqual(["rep-1", "rep-2"]);

    await view.loadDashboardRepertoires();
    expect(ids()).toEqual(["rep-9"]);
    expect(rows()[0].classList.contains("is-enter")).toBe(true);
  });
});
