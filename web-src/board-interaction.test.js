// One gesture, one sound, and the board's marks follow the move.
//
// A drag leaves the piece under the pointer on its target, so the slide that
// every other move gets would replay the drop backwards; a click move really
// travels from the piece's square and keeps its slide. And a move is heard once,
// however many times its position is rendered (an optimistic landing, then the
// confirmed one).
//
// These drive the real BoardController over a small fake DOM, because the rule
// lives in setPosition's drag/click decision, not in the slide itself.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBoardController } from "./board/board-controller.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const MOVES = ["e2e4", "e2e3", "d2d4"];

// The placement field as {square: piece}, which is all the board reads of a FEN.
function parseFenBoard(fen) {
  const out = {};
  const rows = String(fen || "").split(" ")[0].split("/");
  rows.forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else out[`${"abcdefgh"[file]}${8 - r}`] = ch, file += 1;
    }
  });
  return out;
}

// --- the smallest DOM the board needs --------------------------------------
function element(tag = "div") {
  const classes = new Set();
  const el = {
    tag, children: [], dataset: {}, style: {}, attributes: {}, handlers: {},
    animations: [], parent: null, tabIndex: -1, offsetLeft: 0, offsetTop: 0,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, on) =>
        on === undefined
          ? classes.has(name) ? classes.delete(name) : classes.add(name)
          : on ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((n) => classes.add(n)); },
    get className() { return [...classes].join(" "); },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
    set innerHTML(_) { this.children = []; },
    get innerHTML() { return ""; },
    insertAdjacentHTML(_where, markup) {
      if (String(markup).includes('class="piece"')) {
        const piece = element("span");
        piece.className = "piece";
        this.appendChild(piece);
      }
    },
    querySelector(sel) {
      const want = sel.replace(/^\./, "");
      for (const child of this.children) {
        if (child.className.split(" ").includes(want)) return child;
        const found = child.querySelector?.(sel);
        if (found) return found;
      }
      return null;
    },
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    dispatch(type, event = {}) {
      const e = { preventDefault() {}, stopPropagation() {}, button: 0, detail: 1, target: this, ...event };
      (this.handlers[type] || []).forEach((fn) => fn(e));
      return e;
    },
    animate(frames, opts) {
      this.animations.push({ frames, opts });
      return { set onfinish(_) {}, get onfinish() { return null; } };
    },
    contains(node) {
      return this === node || this.children.some((c) => c.contains?.(node));
    },
    closest(sel) {
      const want = sel.replace(/^\./, "");
      return this.className.split(" ").includes(want) ? this : null;
    },
    getBoundingClientRect: () => ({ width: 800, height: 800, left: 0, top: 0 }),
    focus() {},
    blur() {},
  };
  return el;
}

let board, boardEl, document_, window_, sounds;

function mount({ onMove }) {
  const els = { board: element("div"), overlay: element("svg") };
  boardEl = els.board;
  document_ = {
    activeElement: null,
    body: element("body"),
    getElementById: (id) => (id === "board" ? els.board : els.overlay),
    createElement: (tag) => element(tag),
    elementFromPoint: () => null,
  };
  window_ = { addEventListener() {}, removeEventListener() {}, setTimeout: () => 0, __up: [] };
  globalThis.document = document_;
  globalThis.window = window_;
  globalThis.requestAnimationFrame = () => 0;

  sounds = [];
  const BoardController = createBoardController({
    // The move animation is on; reduced motion is not (matchMedia is absent here).
    pref: (name) => name === "moveAnim" || name === "lastMovePulse",
    renderAnnotations: () => {},
    files: ["a", "b", "c", "d", "e", "f", "g", "h"],
    isPromotionMove: () => false,
    resolveBoardMove: () => {},
    legalMoveFor: (from, to, moves) => moves.find((m) => m === `${from}${to}`) || null,
    pieceSvg: () => '<span class="piece"></span>',
    parseFenBoard,
    playSound: (cue) => sounds.push(cue),
    moveCue: () => "move",
    pieceLabel: (piece) => piece,
    legalTargetsFrom: (from, moves) => moves.filter((m) => m.startsWith(from)).map((m) => m.slice(2, 4)),
  });
  board = new BoardController({ boardId: "board", overlayId: "overlay", onMove });
  board.setPosition({ fen: START, legalMoves: MOVES });
  return { board, document: document_, window: window_, els };
}

// The app's shape after a board move: land the move locally, then render it.
function landOnBoard(fen, uci) {
  board.setPosition({ fen, legalMoves: [], lastMove: uci });
}

const square = (name) => board.squares.get(name);
// A slide animates the piece inside its square, so it is recorded there.
const slides = () =>
  [...board.squares.values()]
    .flatMap((sq) => [sq, ...sq.children])
    .flatMap((el) => el.animations.filter((a) => a.frames?.[0]?.transform));
const press = (name) => boardEl.dispatch("pointerdown", { target: square(name) });
const release = (name) => {
  document_.elementFromPoint = () => square(name);
  (window_.__up || []).forEach((fn) => fn({ clientX: 0, clientY: 0, button: 0 }));
};

// window listeners registered by _beginDrag
function captureWindowListeners() {
  const up = [];
  window_.addEventListener = (type, fn) => { if (type === "pointerup") up.push(fn); };
  window_.__up = up;
}

describe("a move made on the board", () => {
  beforeEach(() => {
    sounds = [];
  });

  it("plays no slide for a drag, which leaves the piece under the pointer", () => {
    mount({ onMove: (uci) => landOnBoard(AFTER_E4, uci) });
    captureWindowListeners();
    press("e2");
    release("e4");
    expect(sounds).toEqual(["move"]);
    expect(slides()).toEqual([]);
  });

  it("keeps the slide for a click move, where the piece really travels", () => {
    mount({ onMove: (uci) => landOnBoard(AFTER_E4, uci) });
    captureWindowListeners();
    press("e2");
    release("e2"); // release on the same square: a selection, not a drag
    press("e4");   // the target: the move plays from the pointerdown handler
    expect(sounds).toEqual(["move"]);
    expect(slides()).toHaveLength(1);
  });

  it("keeps the slide for a stepped move, which no pointer made", () => {
    mount({ onMove: () => {} });
    landOnBoard(AFTER_E4, "e2e4");
    expect(slides()).toHaveLength(1);
  });

  it("sounds one move once, though its position is rendered twice", () => {
    mount({ onMove: () => {} });
    // The optimistic landing, then the confirmed position (the server's FEN
    // differs only in the clocks).
    landOnBoard(AFTER_E4, "e2e4");
    landOnBoard(AFTER_E4.replace(" 0 1", " 0 2"), "e2e4");
    expect(sounds).toEqual(["move"]);
  });

  it("still sounds the next move, which is a different one", () => {
    mount({ onMove: () => {} });
    landOnBoard(AFTER_E4, "e2e4");
    landOnBoard("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", "e7e5");
    expect(sounds).toEqual(["move", "move"]);
  });

  it("drops the drawn arrows and circles when the position changes", () => {
    mount({ onMove: () => {} });
    board.setAnnotations(["e2e4"], ["d4"]);
    expect(board.arrows).toEqual(["e2e4"]);
    landOnBoard(AFTER_E4, "e2e4");
    expect(board.arrows).toEqual([]);
    expect([...board.highlights]).toEqual([]);
  });

  it("keeps them on a same-position refresh", () => {
    mount({ onMove: () => {} });
    board.setAnnotations(["e2e4"], ["d4"]);
    // An autosave or a panel re-render arrives with the same position.
    board.setPosition({ fen: START, legalMoves: MOVES });
    expect(board.arrows).toEqual(["e2e4"]);
    expect([...board.highlights]).toEqual(["d4"]);
  });

  it("puts them back when an engine preview ends", () => {
    mount({ onMove: () => {} });
    board.setAnnotations(["e2e4"], ["d4"]);
    board.beginPreview();
    // The preview walks the engine's line, which is not this position.
    board.showPreview({ fen: AFTER_E4, lastMove: "e2e4" });
    board.endPreview();
    expect(board.arrows).toEqual(["e2e4"]);
    expect([...board.highlights]).toEqual(["d4"]);
  });
});
