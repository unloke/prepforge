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
import { caughtPiece } from "./board/move-motion.js";

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
    cloneNode() { const copy = element(this.tag); copy.className = this.className; return copy; },
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
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      // `.piece` and `.piece:not(.piece-caught)` are the only shapes the board
      // asks for.
      const [, want, not] = /^\.([\w-]+)(?::not\(\.([\w-]+)\))?$/.exec(sel) || [];
      const matches = (el) => {
        const names = el.className.split(" ");
        return names.includes(want) && !(not && names.includes(not));
      };
      const found = [];
      for (const child of this.children) {
        if (matches(child)) found.push(child);
        found.push(...(child.querySelectorAll?.(sel) || []));
      }
      return found;
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

// Stepping back through a game lands on the position BEFORE the move being
// undone. The piece that travels is that move's mover, going home — not the
// new position's `lastMove` replayed forward, which animated the piece onto a
// square it had just left and then snapped it back.
describe("a step back through a game", () => {
  const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  const AFTER_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";

  beforeEach(() => {
    sounds = [];
  });

  // The harness's fake squares have no layout, so the offsets a slide reads are
  // given here. g1 is a knight's move from f3.
  function placeSquares() {
    Object.assign(board.squares.get("g1"), { offsetLeft: 0, offsetTop: 700 });
    Object.assign(board.squares.get("f3"), { offsetLeft: 100, offsetTop: 500 });
  }
  const moverOn = (name) =>
    square(name).children.find((c) => c.className.split(" ").includes("piece"));
  const travel = (piece) => piece?.animations.find((a) => a.frames?.[0]?.transform)?.frames[0].transform;

  it("slides the undone move's piece home, from its destination to its origin", () => {
    mount({ onMove: () => {} });
    landOnBoard(AFTER_E4_E5, "e7e5");
    landOnBoard(AFTER_NF3, "g1f3");
    placeSquares();
    sounds.length = 0;
    // Back to the position before 2.Nf3: the knight returns f3 -> g1, so the
    // piece on g1 starts where it stood on f3 (right 100, up 200 from home).
    board.setPosition({ fen: AFTER_E4_E5, legalMoves: [], lastMove: "e7e5", back: true });
    expect(travel(moverOn("g1"))).toBe("translate(100px, -200px)");
    // The square it left is empty, and nothing is held as captured.
    expect(moverOn("f3")).toBeUndefined();
    expect([...board.squares.values()].flatMap((sq) => sq.children).some((c) => c.className.includes("piece-caught"))).toBe(false);
  });

  it("stays silent: the undone move already sounded when it was played", () => {
    mount({ onMove: () => {} });
    landOnBoard(AFTER_E4_E5, "e7e5");
    landOnBoard(AFTER_NF3, "g1f3");
    sounds.length = 0;
    board.setPosition({ fen: AFTER_E4_E5, legalMoves: [], lastMove: "e7e5", back: true });
    expect(sounds).toEqual([]);
  });

  it("leaves the forward move's travel and sound unchanged", () => {
    mount({ onMove: () => {} });
    landOnBoard(AFTER_E4_E5, "e7e5");
    placeSquares();
    sounds.length = 0;
    landOnBoard(AFTER_NF3, "g1f3");
    expect(sounds).toEqual(["move"]);
    expect(travel(moverOn("f3"))).toBe("translate(-100px, 200px)");
    expect(moverOn("g1")).toBeUndefined();
  });
});

// A capture mounts a detached copy of the victim (.piece-caught) on the square
// the mover lands on, so for one move that square holds two .piece elements.
// Rapid navigation — a held ← / →, Next clicked through a game — renders the
// next position while the clone is still fading. The render used to remove at
// most ONE element per square and then treat `data-piece` as proof the square
// was settled, so the leftover stayed; once the FEN emptied that square,
// `data-piece` already read "" and no later render ever revisited it. A piece
// that had been captured sat on the board for the rest of the session (the
// reported phantom rook). Every render now reconciles the square against the
// FEN, so the visible pieces converge on the position whatever overlapped.
describe("a render that lands while a capture is still animating", () => {
  const BEFORE_CAPTURE = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  const AFTER_CAPTURE = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
  // The next position: Black answers elsewhere, so d5 still holds the capturing
  // pawn — the clone has no business standing over it.
  const NEXT_POSITION = "rnbqkbnr/p1p1pppp/1p6/3P4/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";
  // And later the square is empty in the FEN.
  const D5_EMPTY = "rnbqkbnr/ppp1pppp/8/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";

  const piecesOn = (name) => square(name).children.filter((c) => c.className.split(" ").includes("piece"));
  const caughtOn = (name) => piecesOn(name).filter((c) => c.className.includes("piece-caught"));
  const ownOn = (name) => piecesOn(name).filter((c) => !c.className.includes("piece-caught"));

  // The fake square's insertAdjacentHTML only ever makes a bare .piece, so the
  // capture clone is planted the way setPosition plants it.
  function plantCaught(name) {
    const clone = element("span");
    clone.className = "piece piece-caught";
    square(name).appendChild(clone);
    return clone;
  }

  it("does not leave a stale clone when the next position renders over it", () => {
    mount({ onMove: () => {} });
    board.setPosition({ fen: BEFORE_CAPTURE, legalMoves: [] });
    // Land the capture, then render the next position before the fade ends.
    board.setPosition({ fen: AFTER_CAPTURE, legalMoves: [], lastMove: "e4d5" });
    expect(caughtOn("d5").length).toBe(1);
    board.setPosition({ fen: NEXT_POSITION, legalMoves: [], lastMove: "b7b6" });
    // The superseded clone belongs to the position it was drawn for.
    expect(caughtOn("d5").length).toBe(0);
    expect(ownOn("d5").length).toBe(1);
  });

  it("leaves no piece on a square the FEN empties, however many renders it saw", () => {
    mount({ onMove: () => {} });
    board.setPosition({ fen: BEFORE_CAPTURE, legalMoves: [] });
    board.setPosition({ fen: AFTER_CAPTURE, legalMoves: [], lastMove: "e4d5" });
    plantCaught("d5"); // a second overlap, as a held key produces
    board.setPosition({ fen: D5_EMPTY, legalMoves: [], lastMove: null });
    expect(piecesOn("d5")).toEqual([]);
    // And it stays empty on every later render.
    board.setPosition({ fen: D5_EMPTY, legalMoves: [], lastMove: null });
    board.setPosition({ fen: AFTER_CAPTURE, legalMoves: [], lastMove: "e4d5" });
    board.setPosition({ fen: D5_EMPTY, legalMoves: [], lastMove: null });
    expect(piecesOn("d5")).toEqual([]);
  });

  it("draws exactly one piece per occupied square and none on empty ones", () => {
    mount({ onMove: () => {} });
    board.setPosition({ fen: BEFORE_CAPTURE, legalMoves: [] });
    board.setPosition({ fen: AFTER_CAPTURE, legalMoves: [], lastMove: "e4d5" });
    plantCaught("d5");
    board.setPosition({ fen: D5_EMPTY, legalMoves: [], lastMove: null });
    const wrong = [];
    for (const [name, sq] of board.squares) {
      const want = parseFenBoard(D5_EMPTY)[name] || "";
      const own = sq.children.filter((c) => c.className.split(" ").includes("piece") && !c.className.includes("piece-caught"));
      if (sq.dataset.piece !== want) wrong.push(`${name}: data ${sq.dataset.piece} want ${want}`);
      if (own.length !== (want ? 1 : 0)) wrong.push(`${name}: ${own.length} own pieces, want ${want ? 1 : 0}`);
    }
    expect(wrong).toEqual([]);
  });

  it("never clones a fading capture as the next victim", () => {
    // caughtPiece reads the square's OWN piece: a clone left over from the
    // previous move must not become the source of the next capture.
    const sq = element("div");
    const own = element("span");
    own.className = "piece piece-black";
    const clone = element("span");
    clone.className = "piece piece-caught";
    sq.appendChild(clone);
    sq.appendChild(own);
    // The copy carries the cloned piece's own classes, so which source was read
    // is visible in the result.
    const copy = caughtPiece(sq);
    expect(copy.className).toContain("piece-caught");
    expect(copy.className).toContain("piece-black");
    own.remove();
    expect(caughtPiece(sq)).toBeNull();
  });
});
