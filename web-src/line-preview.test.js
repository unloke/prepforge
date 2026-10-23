// Move links on the page: the board line one source at a time, and what a token
// does when it is clicked. No board is drawn beside the text any more, so the
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
// `coach` puts it in the coach card, the one place a token draws on the board.
function token(mt, p, { cls = "move-ref", coach = false, focusable = true } = {}) {
  const el = {
    dataset: { mt, p: String(p) },
    classList: { contains: (c) => c === cls },
    setAttribute: vi.fn(),
  };
  el.matches = (sel) => (sel === "#coach-prose [data-mt][data-p]" ? coach : sel === ":focus-visible" ? focusable : false);
  el.contains = (other) => other === el;
  el.closest = (sel) => {
    if (sel === "#coach-prose [data-mt][data-p]") return coach ? el : null;
    if (sel === ".move-ref[data-p]") return cls === "move-ref" ? el : null;
    return sel === "[data-mt]" ? el : null;
  };
  return el;
}
const ev = (target, extra = {}) => ({ target, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra });

let mod;
const applied = [];
let canApply = true;
const ghosts = [];
const fakeBoard = { setGhost: (ucis) => ghosts.push(ucis) };
beforeAll(async () => {
  mod = await import("./line-preview.js");
  mod.initCoachGhosts(() => fakeBoard);
  mod.initMoveLinks({ apply: (t) => (canApply ? () => applied.push(t.dataset.p) : null) });
});
beforeEach(() => {
  mod.clearCoachGhost();
  applied.length = 0;
  ghosts.length = 0;
  canApply = true;
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

describe("the coach's ghost", () => {
  const LINE = encodeLine(START, ["e2e4", "e7e5", "g1f3"]);
  const hover = (t) => fire("pointerover", ev(t, { pointerType: "mouse" }));
  const leave = (t) => fire("pointerout", ev(t, { pointerType: "mouse", relatedTarget: null }));

  it("draws the sentence's line up to the move named, and clears on leave", () => {
    const first = token(LINE, 0, { coach: true });
    hover(first);
    expect(ghosts.at(-1)).toEqual(["e2e4"]);
    const second = token(LINE, 2, { coach: true });
    hover(second); // straight from one token to the next swaps at once
    expect(ghosts.at(-1)).toEqual(["e2e4", "e7e5", "g1f3"]);
    leave(second);
    expect(ghosts.at(-1)).toEqual([]);
  });

  it("draws only for the coach card's text", () => {
    hover(token(LINE, 1)); // the move list, an engine line: no ghost
    expect(ghosts).toEqual([]);
  });

  it("shows on keyboard focus, and not on a mouse click's focus", () => {
    const t = token(LINE, 1, { coach: true });
    fire("focusin", ev(token(LINE, 1, { coach: true, focusable: false })));
    expect(ghosts).toEqual([]);
    fire("focusin", ev(t));
    expect(ghosts.at(-1)).toEqual(["e2e4", "e7e5"]);
    fire("focusout", ev(t));
    expect(ghosts.at(-1)).toEqual([]);
  });

  it("on touch, a tap shows the ghost instead of jumping, and a second tap clears it", () => {
    const t = token(LINE, 1, { coach: true });
    fire("pointerdown", ev(t, { pointerType: "touch" }));
    fire("click", ev(t));
    expect(applied).toEqual([]); // the tree did not move under the sentence
    expect(ghosts.at(-1)).toEqual(["e2e4", "e7e5"]);
    fire("pointerdown", ev(t, { pointerType: "touch" }));
    fire("click", ev(t));
    expect(ghosts.at(-1)).toEqual([]);
    // A third tap brings it back; a tap elsewhere clears it.
    fire("pointerdown", ev(t, { pointerType: "touch" }));
    fire("click", ev(t));
    expect(ghosts.at(-1)).toEqual(["e2e4", "e7e5"]);
    fire("pointerdown", ev(token(LINE, 0), { pointerType: "touch", target: { closest: () => null } }));
    expect(ghosts.at(-1)).toEqual([]);
  });

  it("clears when the sentence is rewritten under the pointer", () => {
    hover(token(LINE, 1, { coach: true }));
    mod.clearCoachGhost();
    expect(ghosts.at(-1)).toEqual([]);
  });
});
