import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNotices, shouldClearStatusOnNavigate, STATUS_KEY } from "./notices.js";

// Just enough DOM for notices.js: every querySelector(sel) on an element
// returns one stub per selector.
function fakeEl() {
  const listeners = {};
  const parts = new Map();
  const el = {
    dataset: {}, style: {}, hidden: false, textContent: "", title: "", innerHTML: "", isConnected: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    setAttribute() {},
    addEventListener: (type, fn) => { listeners[type] = fn; },
    fire: (type, event = {}) => listeners[type]?.({ stopPropagation() {}, target: { closest: () => null }, ...event }),
    querySelector: (sel) => {
      if (!parts.has(sel)) parts.set(sel, fakeEl());
      return parts.get(sel);
    },
    querySelectorAll: () => [],
    appendChild(child) { el.children.push(child); child.parent = el; },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); },
    contains: () => false,
  };
  Object.defineProperty(el, "offsetWidth", { get: () => 0 });
  return el;
}

let container;
let notices;
beforeEach(() => {
  vi.useFakeTimers();
  globalThis.document = { createElement: fakeEl, addEventListener() {} };
  globalThis.requestAnimationFrame = (fn) => fn();
  container = fakeEl();
  notices = createNotices();
  notices.bind(container);
});
afterEach(() => {
  vi.useRealTimers();
  delete globalThis.document;
  delete globalThis.requestAnimationFrame;
});

const texts = () => notices.cards.map((c) => c.textEl.textContent);

it("merges a repeated message into the visible card", () => {
  notices.show("Offline — will retry", { tone: "warning" });
  const card = notices.show("Offline — will retry", { tone: "warning" });
  expect(notices.cards).toHaveLength(1);
  expect(card.titleEl.hidden).toBe(true);
});

it("keeps one routine status line; errors get their own card and stay", () => {
  notices.status("Renamed to Najdorf");
  notices.status("FEN copied");
  expect(texts()).toEqual(["FEN copied"]);
  notices.status("Save failed", { tone: "error" });
  notices.status("Line PGN copied");
  expect(texts().sort()).toEqual(["Line PGN copied", "Save failed"]);
  vi.advanceTimersByTime(60_000);
  expect(texts()).toEqual(["Save failed"]);
  notices.status("");
  vi.runAllTimers();
  expect(notices.cards).toHaveLength(0);
});

it("shows an in-progress line only if it is still current after a beat", () => {
  notices.status("Preparing your export…");
  expect(notices.cards).toHaveLength(0);
  vi.advanceTimersByTime(700);
  expect(texts()).toEqual(["Preparing your export…"]);
  notices.status("Fetching…");
  notices.status("Export downloaded");
  vi.advanceTimersByTime(700);
  expect(texts()).toEqual(["Export downloaded"]);
});

it("makes room by dropping the oldest plain card, never a running job", () => {
  notices.startJob({ title: "Scout Deep Scan", total: 10, onCancel() {} });
  const undo = notices.show("", { title: "Deleted", duration: 5000, actions: [{ label: "Undo" }] });
  notices.show("a");
  notices.show("b");
  notices.show("c");
  expect(notices.cards).toHaveLength(4);
  expect(notices.isBusy()).toBe(true);
  expect(notices.cards).toContain(undo);
  expect(texts()).not.toContain("a");
});

it("runs onClose once however the card goes, and hover pauses the timer", () => {
  const onClose = vi.fn();
  const card = notices.show("", { title: "Deleted", duration: 5000, onClose, actions: [{ label: "Undo" }] });
  vi.advanceTimersByTime(3000);
  card.el.fire("pointerenter");
  vi.advanceTimersByTime(10_000);
  expect(onClose).not.toHaveBeenCalled();
  card.el.fire("pointerleave");
  vi.advanceTimersByTime(2000);
  expect(onClose).toHaveBeenCalledOnce();
  card.dismiss();
  expect(onClose).toHaveBeenCalledOnce();
});

it("a failed job stays until dismissed; a finished one leaves", () => {
  notices.startJob({ title: "Previewing replies", total: 2 });
  notices.failJob("Engine crashed");
  vi.advanceTimersByTime(60_000);
  expect(notices.cards[0].tone).toBe("error");
  notices.cards[0].dismiss(true);
  notices.startJob({ title: "Previewing replies", total: 2 });
  notices.completeJob({ title: "Replies previewed" });
  vi.advanceTimersByTime(6000);
  expect(notices.cards).toHaveLength(0);
});

it("a docked job replaces the previous card and Analyze's leaves on completion", () => {
  const dock = fakeEl();
  dock.id = "analysis-job-dock";
  const first = notices.startJob({ title: "Analyzing game", dock });
  first.update({ current: 1, total: 10 });
  const next = notices.startJob({ title: "Analyzing game", dock });
  expect(first.removed).toBe(true);
  expect(dock._notice).toBe(next);
  next.complete({ title: "Analysis ready" });
  expect(next.removed).toBe(true);
  expect(dock._notice).toBeNull();
  expect(dock.children).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("drops status lines on navigation unless the navigating action raised them", () => {
  expect(shouldClearStatusOnNavigate(1000, 5000, 400)).toBe(true);
  expect(shouldClearStatusOnNavigate(4900, 5000, 400)).toBe(false);
  expect(shouldClearStatusOnNavigate(0, 5000, 400)).toBe(true);
  notices.status("Joined Team A");
  notices.show("New game", { key: "newgame", actions: [{ label: "Analyze" }] });
  notices.clearStatusOnNavigate(Date.now() + 100);
  expect(notices.cards.map((c) => c.key)).toContain(STATUS_KEY);
  notices.clearStatusOnNavigate(Date.now() + 1000);
  expect(notices.cards.map((c) => c.key)).toEqual(["newgame"]);
});
