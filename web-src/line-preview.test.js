// Move links on the page: the board line one source at a time, and the peek's
// gestures (hover, keyboard, touch) over a small fake DOM. The real-browser check
// of the same gestures is in the visual tour; this pins the rules.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeLine } from "./move-text.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const handlers = {};
function fakeEl() {
  const attrs = {};
  const classes = new Set();
  return {
    _html: "", hidden: false,
    get innerHTML() { return String(this._html); }, set innerHTML(v) { this._html = v; }, style: {}, offsetWidth: 176, offsetHeight: 200, isConnected: true,
    classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k] ?? null, removeAttribute: (k) => { delete attrs[k]; },
    addEventListener(type, fn) { this[`on${type}`] = fn; },
    contains(x) { return x === this; },
    attrs,
  };
}
const body = { append: vi.fn() };
let host = null;

beforeAll(() => {
  globalThis.window = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t), addEventListener: vi.fn() };
  globalThis.document = {
    body,
    documentElement: { clientWidth: 1000, clientHeight: 800 },
    activeElement: null,
    getElementById: () => null,
    createElement: () => (host = fakeEl()),
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
});

// A token as move-text.js writes it: its line in data-mt, its index in data-p.
function token(mt, p, { cls = "move-ref", title = "", parent = null, side = null } = {}) {
  const el = fakeEl();
  el.dataset = { mt, p: String(p) };
  el.classList.add(cls);
  if (title) el.setAttribute("title", title);
  el.matches = (sel) => sel.includes("[data-p]") || sel === ":focus-visible";
  el.closest = (sel) => {
    if (sel === "[title]") return el.getAttribute("title") !== null ? el : parent?.getAttribute("title") != null ? parent : null;
    if (sel === "[data-board-side]") return side ? { dataset: { boardSide: side } } : null;
    return sel.includes("move-ref") && cls !== "move-ref" ? null : el;
  };
  el.getBoundingClientRect = () => ({ left: 100, top: 100, bottom: 120, width: 30 });
  el.focus = vi.fn();
  return el;
}
const ev = (target, extra = {}) => ({ target, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra });

let mod;
const applied = [];
let canApply = true;
beforeAll(async () => {
  mod = await import("./line-preview.js");
  mod.initMoveLinks({
    apply: (t, probe) => (canApply ? (probe ? () => {} : () => applied.push(t.dataset.p)) : null),
    orientation: () => "white",
  });
});
beforeEach(() => {
  applied.length = 0;
  canApply = true;
  mod.hidePeek();
  handlers.pointerdown(ev(null, { pointerType: "mouse", target: { closest: () => null } }));
});

describe("board line", () => {
  function fakeBoard() {
    return {
      shown: [],
      beginPreview({ onEnd }) { this.onEnd = onEnd; this.previewing = true; },
      showPreview(pos) { this.shown.push(pos); },
      endPreview({ restore }) { this.previewing = false; this.onEnd({ restored: restore }); },
    };
  }
  const line = () => ({ baseFen: START, plies: [{ uci: "e2e4", fen: "a", label: "1.e4" }, { uci: "e7e5", fen: "b", label: "1...e5" }] });

  it("steps one line and hands the board back on exit", () => {
    const board = fakeBoard();
    const seen = [];
    mod.boardLine.open({ board, view: "build", line: line(), ply: 1, onChange: (s) => seen.push(s && s.ply) });
    expect(board.shown.at(-1)).toEqual({ fen: "a", lastMove: "e2e4" });
    expect(mod.boardLine.step("next")).toBe(true);
    expect(board.shown.at(-1).lastMove).toBe("e7e5");
    expect(mod.boardLine.step("next")).toBe(true); // clamped at the end
    mod.boardLine.exit();
    expect(board.previewing).toBe(false);
    expect(seen).toEqual([1, 2, 2, null]);
    expect(mod.boardLine.active).toBe(null);
    expect(mod.boardLine.step("next")).toBe(false);
  });

  it("lets a second source take the same board over without restoring it", () => {
    const board = fakeBoard();
    const first = vi.fn();
    mod.boardLine.open({ board, view: "analyze", line: line(), owner: "engine", onChange: first });
    mod.boardLine.open({ board, view: "analyze", line: line(), ply: 2, owner: "note" });
    expect(first).toHaveBeenLastCalledWith(null);
    expect(board.previewing).toBe(true);
    expect(mod.boardLine.active.owner).toBe("note");
    mod.boardLine.exit();
  });
});

describe("peek", () => {
  const LINE = encodeLine(START, ["e2e4", "e7e5", "g1f3"]);

  it("reads the position after a token's move, and nothing from garbage", () => {
    const pos = mod.peekPosition(token(LINE, 2));
    expect(pos).toMatchObject({ label: "2.Nf3", lastMove: "g1f3", ply: 3 });
    expect(pos.fen.startsWith("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/")).toBe(true);
    expect(mod.peekPosition(token(LINE, 7))).toBe(null);
    expect(mod.peekPosition(token("nonsense|e2e4", 0))).toBe(null);
    expect(mod.peekPosition(token(encodeLine(START, ["e2e5"]), 0))).toBe(null);
  });

  it("shows on hover after a short intent delay and hides on leave", () => {
    vi.useFakeTimers();
    const t = token(LINE, 0);
    handlers.pointerover(ev(t, { pointerType: "mouse" }));
    expect(host?.hidden ?? true).toBe(true);
    vi.advanceTimersByTime(150);
    expect(host.hidden).toBe(false);
    expect(host.innerHTML).toContain("1.e4");
    expect(host.innerHTML).toContain("scout-minisquare");
    expect(host.innerHTML).not.toContain("move-peek-go"); // hover is a look, not an action
    handlers.pointerout(ev(t, { pointerType: "mouse", relatedTarget: null }));
    expect(host.hidden).toBe(true);
    vi.useRealTimers();
  });

  it("faces the side its container names, else the active board's", () => {
    // Index of the last-move squares in the 64 drawn: the board's orientation.
    const lastSquares = () => host.innerHTML.split("scout-minisquare").slice(1).flatMap((sq, i) => (sq.startsWith(" light last") || sq.startsWith(" dark last") ? [i] : []));
    handlers.focusin(ev(token(LINE, 2)));
    expect(lastSquares()).toEqual([45, 62]); // f3, g1 with White at the bottom
    mod.hidePeek();
    handlers.focusin(ev(token(LINE, 2, { side: "black" })));
    expect(lastSquares()).toEqual([1, 18]); // g1, f3 with Black at the bottom
  });

  it("carries a control's own tooltip in the peek and puts it back", () => {
    const t = token(LINE, 1, { title: "Due for review" });
    handlers.focusin(ev(t));
    expect(t.getAttribute("title")).toBe(null);
    expect(host.innerHTML).toContain("Due for review");
    mod.hidePeek();
    expect(t.getAttribute("title")).toBe("Due for review");
  });

  it("lifts the row's tooltip while a move in it peeks, without showing it", () => {
    const row = fakeEl();
    row.setAttribute("title", "1.e4 e5 2.Nf3");
    const t = token(LINE, 1, { cls: "move-peek-ref", parent: row });
    vi.useFakeTimers();
    handlers.pointerover(ev(t, { pointerType: "mouse" }));
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    expect(host.hidden).toBe(false);
    expect(row.getAttribute("title")).toBe(null);
    expect(host.innerHTML).not.toContain("move-peek-note");
    mod.hidePeek();
    expect(row.getAttribute("title")).toBe("1.e4 e5 2.Nf3");
  });

  it("applies on click or Enter where the view has a board", () => {
    const t = token(LINE, 1);
    const click = ev(t);
    handlers.click(click);
    expect(applied).toEqual(["1"]);
    expect(click.stopPropagation).toHaveBeenCalled(); // a token inside a row is its own control
    handlers.keydown(ev(t, { key: "Enter" }));
    expect(applied).toEqual(["1", "1"]);
  });

  it("pins the peek instead where the view has nothing to apply it to", () => {
    canApply = false;
    const t = token(LINE, 1);
    handlers.click(ev(t));
    expect(applied).toEqual([]);
    expect(host.hidden).toBe(false);
    expect(host.classList.contains("is-pinned")).toBe(true);
    expect(host.innerHTML).not.toContain("move-peek-go");
    handlers.click(ev(t)); // a second click closes it
    expect(host.hidden).toBe(true);
  });

  it("on touch, a tap previews with an explicit apply, and a second tap applies", () => {
    const t = token(LINE, 2);
    handlers.pointerdown(ev(t, { pointerType: "touch", target: { closest: () => t } }));
    handlers.click(ev(t));
    expect(applied).toEqual([]);
    expect(host.hidden).toBe(false);
    expect(host.innerHTML).toContain("Show on board");
    handlers.click(ev(t));
    expect(applied).toEqual(["2"]);
    expect(host.hidden).toBe(true);
  });

  it("closes with Escape before anything else hears it", () => {
    const t = token(LINE, 0);
    handlers.focusin(ev(t));
    const esc = ev(t, { key: "Escape" });
    handlers.keydown(esc);
    expect(host.hidden).toBe(true);
    expect(esc.stopImmediatePropagation).toHaveBeenCalled();
    const again = ev(t, { key: "Escape" });
    handlers.keydown(again); // nothing open: the board's own Esc gets it
    expect(again.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("lets Escape through when the peek is only under the pointer", () => {
    const t = token(LINE, 0);
    vi.useFakeTimers();
    handlers.pointerover(ev(t, { pointerType: "mouse" }));
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    expect(host.hidden).toBe(false);
    const esc = ev(t, { key: "Escape" });
    handlers.keydown(esc); // an open dialog or menu still closes on this press
    expect(host.hidden).toBe(true);
    expect(esc.preventDefault).not.toHaveBeenCalled();
    expect(esc.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("ignores hover on touch and leaves peek-only tokens' clicks to their row", () => {
    const t = token(LINE, 0, { cls: "move-peek-ref" });
    const click = ev(t);
    handlers.click(click);
    expect(click.stopPropagation).not.toHaveBeenCalled();
    handlers.pointerover(ev(t, { pointerType: "touch" }));
    expect(applied).toEqual([]);
  });

  // Where the peek lands: beside the sentence, never over it, and inside the
  // screen at 390.
  const placed = () => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(host.style.transform || "");
    return m ? { x: Number(m[1]), y: Number(m[2]), w: host.offsetWidth, h: host.offsetHeight } : null;
  };
  const inSentence = (el, box) => {
    const r = el.getBoundingClientRect();
    return box.x < r.right && box.x + box.w > r.left && box.y < r.bottom && box.y + box.h > r.top;
  };

  it("opens beside the sentence, not over the words being read", () => {
    const line = fakeEl();
    line.getBoundingClientRect = () => ({ left: 924, top: 100, right: 1380, bottom: 130, width: 456, height: 30 });
    const t = token(LINE, 0);
    t.getBoundingClientRect = () => ({ left: 1100, top: 105, right: 1126, bottom: 125, width: 26, height: 20 });
    t.closest = (sel) => (sel === "[data-mt]" || sel.includes("[data-p]") ? t : sel === "[data-board-side]" ? null : sel === "[title]" ? null : line);
    const vw = document.documentElement.clientWidth;
    document.documentElement.clientWidth = 1440;
    try {
      handlers.focusin(ev(t));
      expect(host.hidden).toBe(false);
      const box = placed();
      // Right gutter: 1440 - 1380 - 8 - 8 = 44px (not enough for 176px peek)
      // Left gutter: 924 - 8 - 8 = 908px (enough), so peek opens left of sentence
      expect(box.x).toBe(740); // 924 - 8 - 176
      expect(inSentence(line, box)).toBe(false);
    } finally {
      document.documentElement.clientWidth = vw;
      mod.hidePeek();
    }
  });

  it("falls back above the word when neither side has room, inside the screen", () => {
    const line = fakeEl();
    line.getBoundingClientRect = () => ({ left: 0, top: 400, right: 390, bottom: 430, width: 390, height: 30 });
    const t = token(LINE, 0);
    t.getBoundingClientRect = () => ({ left: 120, top: 405, right: 150, bottom: 425, width: 30, height: 20 });
    t.closest = (sel) => (sel === "[data-mt]" || sel.includes("[data-p]") ? t : sel === "[data-board-side]" ? null : sel === "[title]" ? null : line);
    const vw = document.documentElement.clientWidth;
    document.documentElement.clientWidth = 390; // a phone
    try {
      handlers.focusin(ev(t));
      const box = placed();
      // No gutter on either side of a full-width sentence: above the word
      // (405 - 8 - 200), and wholly on the 390px screen.
      expect(box.y).toBe(197);
      expect(box.y + box.h).toBeLessThanOrEqual(405);
      expect(box.x).toBeGreaterThanOrEqual(8);
      expect(box.x + box.w).toBeLessThanOrEqual(390 - 8);
      expect(inSentence(line, box)).toBe(false);
    } finally {
      document.documentElement.clientWidth = vw;
      mod.hidePeek();
    }
  });

  it("keeps clear of a surface it is asked to avoid", () => {
    const chart = { isConnected: true, getBoundingClientRect: () => ({ left: 86, top: 400, right: 764, bottom: 464, width: 678, height: 64 }) };
    const t = token(LINE, 1);
    mod.peekAt(t, { avoid: chart });
    const box = placed();
    expect(host.hidden).toBe(false);
    // Not on the plot at all, and wholly on screen (the fake screen is 1000x800).
    // The peek goes under or over the plot, never beside it, where the plot
    // would still be the nearest thing to the pointer.
    expect(box.y + box.h <= 400 || box.y >= 464).toBe(true);
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.y).toBeGreaterThanOrEqual(8);
    expect(box.x + box.w).toBeLessThanOrEqual(1000 - 8);
    expect(box.y + box.h).toBeLessThanOrEqual(800 - 8);
    mod.hidePeek();
  });
});
