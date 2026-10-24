// Move links on the page: what a token does when it is clicked, and the peek
// on the Analyze board. No board is drawn beside the text any more, so the
// module must never create one — the last test pins that.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeLine } from "./move-text.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const handlers = {};
const fire = (type, event) => (handlers[type] || []).forEach((fn) => fn(event));

beforeAll(() => {
  globalThis.document = {
    createElement: vi.fn(),
    getElementById: () => null,
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
  };
});

// A token as move-text.js writes it: its line in data-mt, its index in data-p.
// `coach` puts it in the coach card, `engine` in an engine line: the places a token peeks.
const PEEK = "#coach-prose [data-mt][data-p], #analysis-engine-slot [data-mt] [data-p], #build-branchbar [data-mt][data-p]";
function token(mt, p, { cls = "move-ref", coach = false, engine = false, focusable = true } = {}) {
  const el = {
    dataset: { mt, p: String(p) },
    classList: { contains: (c) => c === cls },
    setAttribute: vi.fn(),
  };
  el.matches = (sel) => (sel === "#coach-prose [data-mt][data-p]" ? coach : sel === ":focus-visible" ? focusable : false);
  el.contains = (other) => other === el;
  el.closest = (sel) => {
    if (sel === PEEK) return coach || engine ? el : null;
    if (sel === ".move-ref[data-p]") return cls === "move-ref" ? el : null;
    return sel === "[data-mt]" ? el : null;
  };
  return el;
}
const ev = (target, extra = {}) => ({ target, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra });

let mod;
const applied = [];
let canApply = true;
const peeks = []; // the move each peek shows, null when it ends
const fakeBoard = { peek: (pos) => peeks.push(pos ? pos.lastMove : null) };
beforeAll(async () => {
  mod = await import("./line-preview.js");
  mod.initPeeks(() => fakeBoard);
  mod.initMoveLinks({ apply: (t) => (canApply ? () => applied.push(t.dataset.p) : null) });
});
beforeEach(() => {
  mod.clearPeek();
  applied.length = 0;
  peeks.length = 0;
  canApply = true;
});

describe("move links", () => {
  const LINE = encodeLine(START, ["e2e4", "e7e5", "g1f3"]);

  it("reads the position after a token's move, and nothing from garbage", () => {
    const pos = mod.tokenPosition(token(LINE, 2));
    expect(pos).toMatchObject({ label: "2.Nf3", lastMove: "g1f3", ply: 3 });
    expect(pos.fen.startsWith("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/")).toBe(true);
    expect(mod.tokenPosition(token(LINE, 7))).toBe(null);
    expect(mod.tokenPosition(token("nonsense|e2e4", 0))).toBe(null);
    expect(mod.tokenPosition(token(encodeLine(START, ["e2e5"]), 0))).toBe(null);
  });

  it("applies on click or Enter where the view has a board", () => {
    const t = token(LINE, 1);
    const click = ev(t);
    fire("click", click);
    expect(applied).toEqual(["1"]);
    expect(click.stopPropagation).toHaveBeenCalled(); // a token inside a row is its own control
    fire("keydown", ev(t, { key: "Enter" }));
    expect(applied).toEqual(["1", "1"]);
  });

  it("leaves a click where the view has nothing to apply it to", () => {
    canApply = false;
    const t = token(LINE, 1);
    const click = ev(t);
    fire("click", click);
    expect(applied).toEqual([]);
    expect(click.stopPropagation).toHaveBeenCalled(); // still the token's own click, not its row's
  });

  it("leaves a click on a token inside a row to that row", () => {
    const click = ev(token(LINE, 1, { cls: "move-inline" }));
    fire("click", click);
    expect(applied).toEqual([]);
    expect(click.stopPropagation).not.toHaveBeenCalled();
  });

  it("never draws a board beside the text", () => {
    fire("click", ev(token(LINE, 1)));
    fire("keydown", ev(token(LINE, 1), { key: " " }));
    expect(document.createElement).not.toHaveBeenCalled();
  });
});

describe("the peek", () => {
  const LINE = encodeLine(START, ["e2e4", "e7e5", "g1f3"]);
  const hover = (t) => fire("pointerover", ev(t, { pointerType: "mouse" }));
  const elsewhere = { closest: () => null };

  it("shows the named move's position, and ends where the pointer goes next", () => {
    const first = token(LINE, 0, { coach: true });
    hover(first);
    expect(peeks).toEqual(["e2e4"]);
    hover(token(LINE, 2, { coach: true })); // straight from one token to the next swaps at once
    expect(peeks).toEqual(["e2e4", "g1f3"]);
    hover(elsewhere);
    expect(peeks).toEqual(["e2e4", "g1f3", null]);
  });

  it("peeks from engine lines too, and not from other text", () => {
    hover(token(LINE, 1)); // the move list, a report: no peek
    expect(peeks).toEqual([]);
    hover(token(LINE, 1, { cls: "pv-move", engine: true }));
    expect(peeks).toEqual(["e7e5"]);
  });

  it("shows on keyboard focus, and not on a mouse click's focus", () => {
    const t = token(LINE, 1, { coach: true });
    fire("focusin", ev(token(LINE, 1, { coach: true, focusable: false })));
    expect(peeks).toEqual([]);
    fire("focusin", ev(t));
    expect(peeks).toEqual(["e7e5"]);
    fire("focusout", ev(t));
    expect(peeks).toEqual(["e7e5", null]);
  });

  it("on touch, a tap peeks instead of jumping, and a second tap ends it", () => {
    const t = token(LINE, 1, { coach: true });
    const tap = (target) => { fire("pointerdown", ev(target, { pointerType: "touch" })); fire("click", ev(target)); };
    tap(t);
    expect(applied).toEqual([]); // the tree did not move under the sentence
    expect(peeks).toEqual(["e7e5"]);
    tap(t);
    expect(peeks).toEqual(["e7e5", null]);
    // A third tap brings it back; a tap elsewhere ends it.
    tap(t);
    fire("pointerdown", ev(elsewhere, { pointerType: "touch" }));
    expect(peeks).toEqual(["e7e5", null, "e7e5", null]);
  });

  it("ends when the sentence is rewritten under the pointer", () => {
    hover(token(LINE, 1, { coach: true }));
    mod.clearPeek();
    expect(peeks.at(-1)).toBe(null);
  });
});
