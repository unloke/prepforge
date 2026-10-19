// Regressions for the Coverage dock tab (item 11 of the 2026-10-18 UI review):
// an empty panel needs to say how to get a first result, opening the tab must
// not preselect a control, and a scan must report the Maia cold-init step
// instead of sitting at "0 positions" with no explanation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCoverageController } from "./controllers/coverage.js";
import { maiaInitMessage } from "./maia-init-notice.js";

// One query-capable element per selector, like notices.test.js's fakeEl.
// innerHTML is a real accessor (the controller assigns to it) and the parts it
// names are queryable, so the panel's rendered markup is observable.
function fakeEl(tag = "DIV", attrs = {}) {
  const listeners = {};
  const parts = new Map();
  let attr = {};
  let markup = "";
  const el = {
    tagName: tag, dataset: {}, style: {}, hidden: false, textContent: "", title: "",
    checked: false, disabled: false, value: "", className: "", id: "",
    parent: null, isConnected: true, ...attrs,
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { if (on === undefined) this._set.has(c) ? this._set.delete(c) : this._set.add(c); else if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    children: [],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    setAttribute(name, value) { attr = { ...attr, [name]: String(value) }; },
    getAttribute(name) { return name in attr ? attr[name] : null; },
    fire(type, event = {}) { (listeners[type] || []).forEach((fn) => fn({ stopPropagation() {}, target: { closest: () => null }, ...event })); },
    // Selector → a stub that remembers the markup the host rendered, so a test
    // can assert on what a live line or empty state contains.
    querySelector: (sel) => {
      const cls = sel.startsWith(".") ? sel.slice(1) : sel;
      if (!parts.has(cls)) parts.set(cls, fakeEl("DIV", { className: cls }));
      return parts.get(cls);
    },
    querySelectorAll: () => [],
    appendChild(child) { el.children.push(child); child.parent = el; },
    contains: () => false,
    remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); },
    closest: () => null,
  };
  Object.defineProperty(el, "innerHTML", {
    get: () => markup,
    set: (v) => { markup = String(v); },
    configurable: true,
  });
  return el;
}

const NODES = [
  { id: "n0", parent_id: null, depth: 0, fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", is_enabled: true, is_prepared: false },
  { id: "n1", parent_id: "n0", depth: 1, uci: "e2e4", san: "e4", fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", is_enabled: true, is_prepared: true, is_mainline: true },
];
const BUILD = { repertoire_id: "r", revision: 1, color: "white", nodes: NODES };

// A live tree the scan can walk: a prepared 1.e4, then the opponent position at
// 1...e5 where Maia's replies decide the three shares.
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E5_FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const LIVE_NODES = [
  { id: "n0", parent_id: null, depth: 0, fen: START_FEN, is_enabled: true, is_prepared: false },
  { id: "n1", parent_id: "n0", depth: 1, uci: "e2e4", san: "e4", fen: AFTER_E4_FEN, is_enabled: true, is_prepared: true, is_mainline: true },
  { id: "n2", parent_id: "n1", depth: 2, uci: "e7e5", san: "e5", fen: AFTER_E5_FEN, is_enabled: true, is_prepared: false },
];

function harness({ provider, predictions, context: contextPatch } = {}) {
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id); };
  const scopeHost = fakeEl();
  Object.defineProperty(scopeHost, "querySelector", { value: () => fakeEl("BUTTON", { dataset: { scope: "repertoire" } }) });
  els.set("coverage-scope", scopeHost);
  const depth = el("coverage-depth");
  depth.value = "16";
  depth.tagName = "SELECT";
  const gaps = el("coverage-gaps");
  el("coverage-run").tagName = "BUTTON";
  el("build-coverage-count");
  el("coverage-job-dock");
  const context = { build: BUILD, rating: 1500, readOnly: false, selectedNodeId: "n0", ...(contextPatch || {}) };
  const job = {
    isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(),
    completeJob: vi.fn(), failJob: vi.fn(), cancelJob: vi.fn(),
  };
  globalThis.document = {
    getElementById: (id) => els.get(id) || null,
    querySelector: (sel) => els.get(sel.replace(/^#/, "")) || null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const controller = createCoverageController({
    getContext: () => context,
    getProvider: () => provider || { predictions: predictions || (async () => []) },
    selectNode: async () => {}, getBoard: () => null,
    previewReplies: async () => {}, getJob: () => job, onError: () => {},
  });
  return { controller, job, gaps, depth, context, els, badge: el("build-coverage-count") };
}

describe("Coverage panel state", () => {
  let h;
  beforeEach(() => { h = harness(); });

  it("stays blank until a repertoire is open", () => {
    h.context.build = null;
    h.controller.paint();
    expect(h.gaps.innerHTML).toBe("");
  });

  it("names the action that fills the panel when it is empty", () => {
    h.controller.paint();
    expect(h.gaps.innerHTML).toContain("coverage-empty");
    expect(h.gaps.innerHTML).not.toContain("<button");
  });

  it("hides the empty state once a scan has run", async () => {
    h.controller.paint();
    expect(h.gaps.innerHTML).toContain("coverage-empty");
    const running = h.controller.scan();
    expect(h.gaps.innerHTML).not.toContain("coverage-empty");
    expect(h.gaps.innerHTML).toContain("Starting Maia engine");
    await running;
    // The empty state is gone for good: the result summary replaces it.
    expect(h.gaps.innerHTML).not.toContain("coverage-empty");
    expect(h.gaps.innerHTML).toContain("coverage-summary");
  });

  it("opens the tab without focusing or selecting the horizon control", () => {
    // setBuildInspector() only flips `hidden`; nothing on the Coverage path
    // calls focus()/select(), so the next Tab lands where the user left it and
    // no control carries a preselected "8 moves" a keypress could overwrite.
    const focus = vi.fn(), select = vi.fn();
    h.depth.focus = focus;
    h.depth.select = select;
    h.controller.sync();
    h.controller.paint();
    expect(focus).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(h.depth.value).toBe("16");
  });
});

describe("Coverage scan progress", () => {
  it("names the Maia cold-init step before the first position", async () => {
    const subscribers = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const provider = {
      subscribeInitProgress: (fn) => { subscribers.push(fn); return () => {}; },
      // Hold the first read open, so the panel is observed before any position lands.
      predictions: async () => { await gate; return []; },
    };
    const h = harness({ provider });
    const started = h.controller.scan();
    // The panel says what the scan is doing from the first frame.
    expect(h.gaps.innerHTML).toContain("Starting Maia engine");
    subscribers.forEach((fn) => fn({ phase: "download", loaded: 5, total: 10 }));
    expect(h.gaps.innerHTML).toContain("Downloading Maia model · 50%");
    subscribers.forEach((fn) => fn({ phase: "verify" }));
    expect(h.gaps.innerHTML).toContain("Verifying Maia model");
    expect(h.job.updateJob.mock.calls.some(([u]) => u.message === "Verifying Maia model")).toBe(true);
    // Once the provider answers, the step becomes the position count.
    release();
    await started;
    expect(h.job.updateJob.mock.calls.some(([u]) => u.phase === "scan" && u.message === "1 position")).toBe(true);
  });

  it("keeps the job card indeterminate while no position has been read", async () => {
    const h = harness();
    await h.controller.scan();
    // current stays 0/0 through the init phase, so the card's bar renders
    // indeterminate instead of never moving.
    const init = h.job.updateJob.mock.calls.map(([u]) => u).find((u) => u.phase === "init");
    expect(init).toMatchObject({ current: 0, total: 0 });
    expect(init.message).toBe("Starting Maia engine");
  });

  // Only the live path (context.build + predictions) reaches the summary.
  const scanLive = async (predictions) => {
    // The controller probes `context.build` again: keep it live for the run.
    const build = { repertoire_id: "r", revision: 1, color: "white", nodes: LIVE_NODES };
    const h = harness({ predictions: async () => predictions, context: { build } });
    await h.controller.scan();
    return h;
  };

  // The summary's three figures are one whole: rounding each on its own made
  // "0.0% prepared / 100.0% missing / <0.1% unchecked" read as over 100%.
  // Read the two printed figures the summary writes (the prepared share, the
  // missing share, and the unchecked remainder when there is one).
  const figures = (markup) => {
    const read = (re) => {
      const m = markup.match(re);
      if (!m) return null;
      return m[1] === "<0.1%" ? "<0.1%" : Number(m[1].slice(0, -1));
    };
    // NB: one inline tag per line, so ">" and the text are never separated by
    // the template's newline + indentation.
    return {
      prepared: read(/<b>((?:<0\.1|[\d.]+)%) prepared<\/b>/),
      missing: read(/>([<\d.]+%) missing</),
      unchecked: read(/>([<\d.]+%) unchecked</),
    };
  };

  it("prints the three shares as one whole that never exceeds 100%", async () => {
    const runs = [
      [[{ move_uci: "e7e5", probability: 0.99995 }], "a sliver of unaccounted mass"],
      [[{ move_uci: "e7e5", probability: 0.5 }, { move_uci: "e7e6", probability: 0.49996 }, { move_uci: "a7a6", probability: 0.00004 }], "two big replies"],
      [[{ move_uci: "e7e5", probability: 1 }], "a complete distribution"],
    ];
    const seen = [];
    for (const [predictions, label] of runs) {
      const h = await scanLive(predictions);
      seen.push({ label, f: figures(String(h.gaps.innerHTML)) });
    }
    // One whole: never more than 100%, and it accounts for (nearly) all of it.
    // The reader always gets a numeric missing share, and a share that rounds
    // to nothing reads "<0.1%", never "0.0%".
    expect(seen).toHaveLength(3);
    for (const { label, f } of seen) {
      expect(f, label).toBeTruthy();
      const written = [f.prepared, f.missing, f.unchecked].filter((x) => x !== null);
      expect(written, label).not.toContain("0.0%");
      expect(typeof f.missing, label).toBe("number");
      const n = (x) => (typeof x === "number" ? x : x === "<0.1%" ? 0.05 : 0);
      const total = n(f.prepared) + n(f.missing) + n(f.unchecked);
      expect(total, label).toBeLessThanOrEqual(100.001);
      expect(total, label).toBeGreaterThan(99);
    }
    // The three runs really differ: a sliver of unchecked mass, a split, and a
    // complete hit: only the first has unchecked mass.
    expect(seen.map((s) => s.f.missing)).toEqual([99.9, 100, 100]);
  });

  it("counts the gaps on the tab badge and says what the number is", async () => {
    const h = await scanLive([{ move_uci: "e7e5", probability: 1 }]);
    expect(h.badge.hidden).toBe(false);
    expect(h.badge.textContent).toBe("1");
    // A bare number never stands alone: the tooltip names it, and the summary
    // spells out what the count is made of, in the rows' own words.
    expect(h.badge.title).toBe("1 gap from the last scan");
    expect(h.badge.getAttribute("aria-label")).toBe("1 gap from the last scan");
    expect(h.gaps.innerHTML).toContain("1 missing reply");
  });

  it("hides a zero badge instead of showing a bare 0", () => {
    const h = harness();
    // No scan has run: nothing is waiting in the tab.
    h.controller.paint();
    expect(h.badge.hidden).toBe(true);
    expect(h.badge.getAttribute("aria-label")).toBe("");
  });

  it("reports the prepared share without a status suffix", async () => {
    const h = harness();
    await h.controller.scan();
    expect(h.gaps.innerHTML).toContain("prepared");
    expect(h.gaps.innerHTML).not.toContain("partial");
    expect(h.job.completeJob.mock.calls[0][0].message).toBe("0.0% prepared");
  });

  it("stops reporting init steps once the scan has finished", async () => {
    const subscribers = [];
    const provider = {
      subscribeInitProgress: (fn) => { subscribers.push(fn); return () => {}; },
      predictions: async () => [],
    };
    const h = harness({ provider });
    await h.controller.scan();
    const before = h.job.updateJob.mock.calls.length;
    subscribers.forEach((fn) => fn({ phase: "download", loaded: 5, total: 10 }));
    expect(h.job.updateJob.mock.calls.length).toBe(before);
  });
});
