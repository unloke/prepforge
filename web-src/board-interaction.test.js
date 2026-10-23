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

  // Analyze draws the engine's move and the move that should have been played;
  // Build draws the fork's options. They are not part of the game's own marks,
  // so nothing else on the board may take their setters away.
  it("draws the engine's move, the better move and the fork's options", () => {
    mount({ onMove: () => {} });
    board.setEngineArrow("e2e4");
    board.setBetterArrow("d2d4");
    board.setBranchArrows(["g1f3", "b1c3"], "b1c3");
    expect(board.engineArrow).toBe("e2e4");
    expect(board.betterArrow).toBe("d2d4");
    expect(board.branchArrows).toEqual(["g1f3", "b1c3"]);
    expect(board.branchPick).toBe("b1c3");
    board.setEngineArrow(null);
    board.setBetterArrow("");
    expect(board.engineArrow).toBe(null);
    expect(board.betterArrow).toBe(null);
  });

  // The old engine preview mode is gone; ghost lines serve a different purpose.
  // This test verifies the board still correctly restores annotations after
  // other changes that previously used preview.
  it("restores state on position change", () => {
    mount({ onMove: () => {} });
    board.setAnnotations(["e2e4"], ["d4"]);
    board.lastMove = "e2e4";
    board.setPosition({ fen: AFTER_E4, legalMoves: [], lastMove: null });
    expect(board.arrows).toEqual([]);
    expect([...board.highlights]).toEqual([]);
    expect(board.lastMove).toBeNull();
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

// Every board in the app steps back — a parent node in a repertoire, a practice
// takeback, an analysis branch — and only Analyze's mainline ever told the board
// so. Without that hint the old slide replayed the move being undone, forward,
// from a square the piece had already left, while the piece that really had to
// travel home was simply re-rendered. The board now reads the direction off the
// two positions, so all of them travel the same way, and a jump is a cut.
describe("stepping back on any board", () => {
  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const AFTER_E4_C6 = "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  const BEFORE_CAPTURE = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  const AFTER_CAPTURE = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
  const BEFORE_EP = "rnbqkbnr/pp1ppppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
  const AFTER_EP = "rnbqkbnr/pp1ppppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3";
  const BEFORE_CASTLE = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
  const AFTER_CASTLE = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4";
  const BEFORE_PROMO = "8/P6k/8/8/8/8/6K1/8 w - - 0 1";
  const AFTER_PROMO = "Q7/7k/8/8/8/8/6K1/8 b - - 0 1";
  const THREE_PLIES = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";

  // Real geometry: a square is 100px; white has rank 8 on top, black the reverse.
  function layout(orientation = "white") {
    for (const [name, sq] of board.squares) {
      const file = "abcdefgh".indexOf(name[0]);
      const rank = Number(name[1]);
      sq.offsetLeft = (orientation === "white" ? file : 7 - file) * 100;
      sq.offsetTop = (orientation === "white" ? 8 - rank : rank - 1) * 100;
    }
  }

  beforeEach(() => {
    mount({ onMove: () => {} });
    layout();
  });

  const own = (name) =>
    square(name).children.filter((c) => c.className.split(" ").includes("piece") && !c.className.includes("piece-caught"));
  const caught = (name) => square(name).children.filter((c) => c.className.includes("piece-caught"));
  // The last transform the square's piece was given, so a piece that is reused
  // across renders is read at its newest animation.
  const travelOn = (name) =>
    own(name)[0]?.animations.filter((a) => a.frames?.[0]?.transform).at(-1)?.frames[0].transform;
  const fades = () =>
    [...board.squares.values()]
      .flatMap((sq) => [sq, ...sq.children])
      .flatMap((el) => el.animations.filter((a) => a.frames?.[0]?.opacity !== undefined));
  const slidesOnBoard = () =>
    [...board.squares.values()]
      .flatMap((sq) => [sq, ...sq.children])
      .filter((el) => el.animations.some((a) => a.frames?.[0]?.transform));
  const pieceAnimations = () =>
    [...board.squares.values()]
      .flatMap((sq) => [sq, ...sq.children])
      .reduce((total, el) => total + el.animations.length, 0);
  // A build/train/replay step: the caller passes the new position's own last
  // move and nothing about direction.
  const step = (fen, lastMove = null, back = false) => board.setPosition({ fen, legalMoves: [], lastMove, back });

  it("sends the undone move home instead of replaying it forward", () => {
    landOnBoard(AFTER_E4, "e2e4");
    step(AFTER_E4_C6, "c7c6");
    const e4Runs = own("e4")[0].animations.length;
    step(AFTER_E4, "e2e4"); // click the parent node: nothing says "back"
    // The c-pawn travels c6 -> c7, and the e-pawn that is already home is left
    // alone: its landed move is not replayed.
    expect(travelOn("c7")).toBe("translate(0px, 100px)");
    expect(own("e4")[0].animations.length).toBe(e4Runs);
  });

  it("takes back two plies with both pieces travelling home", () => {
    landOnBoard(AFTER_E4, "e2e4");
    step(AFTER_E4_C6, "c7c6");
    // Train's takeback: no move to highlight, and it says it is a step back.
    step(START_FEN, null, true);
    expect(travelOn("e2")).toBe("translate(0px, -200px)");
    expect(travelOn("c7")).toBe("translate(0px, 100px)");
    expect(own("e4")).toHaveLength(0);
    expect(own("c6")).toHaveLength(0);
  });

  it("gives the captured piece back instead of holding a ghost", () => {
    landOnBoard(BEFORE_CAPTURE, null);
    step(AFTER_CAPTURE, "e4d5");
    expect(caught("d5")).toHaveLength(1);
    step(BEFORE_CAPTURE, null);
    // The taken pawn is back on d5, drawn by the FEN, with the fade-in the step
    // back earns — not a capture clone, which would fade the wrong way.
    expect(own("d5")).toHaveLength(1);
    expect(caught("d5")).toHaveLength(0);
    expect(own("e4")).toHaveLength(1);
    expect(travelOn("e4")).toBe("translate(-100px, -100px)");
    expect(fades()).toHaveLength(1);
    expect(fades()[0].frames[0].opacity).toBe(0);
  });

  it("brings an en passant victim back beside the pawn", () => {
    landOnBoard(BEFORE_EP, null);
    step(AFTER_EP, "e5d6");
    expect(own("d6")).toHaveLength(1);
    expect(caught("d5")).toHaveLength(1);
    step(BEFORE_EP, null);
    // The pawn returns to e5 and the victim to d5, not to the square the pawn
    // left.
    expect(own("e5")).toHaveLength(1);
    expect(own("d5")).toHaveLength(1);
    expect(caught("d5")).toHaveLength(0);
    expect(own("d6")).toHaveLength(0);
    expect(travelOn("e5")).toBe("translate(-100px, -100px)");
  });

  it("moves the rook home with the king when castling is undone", () => {
    landOnBoard(BEFORE_CASTLE, null);
    step(AFTER_CASTLE, "e1g1");
    expect(travelOn("g1")).toBe("translate(-200px, 0px)");
    expect(travelOn("f1")).toBe("translate(200px, 0px)");
    step(BEFORE_CASTLE, null);
    // Both pieces travel: no teleporting rook, in either direction.
    expect(travelOn("e1")).toBe("translate(200px, 0px)");
    expect(travelOn("h1")).toBe("translate(-200px, 0px)");
  });

  it("returns a promoted pawn to the square it came from", () => {
    landOnBoard(BEFORE_PROMO, null);
    step(AFTER_PROMO, "a7a8q");
    expect(own("a8")).toHaveLength(1);
    step(BEFORE_PROMO, null);
    expect(own("a7")).toHaveLength(1);
    expect(own("a8")).toHaveLength(0);
    expect(travelOn("a7")).toBe("translate(0px, -100px)");
  });

  it("draws a jump between lines as a cut, not a wrong-origin slide", () => {
    landOnBoard(AFTER_E4, "e2e4");
    const before = pieceAnimations();
    // Three plies away: no single move explains the change.
    step(THREE_PLIES, "g1f3");
    expect(pieceAnimations()).toBe(before);
    expect(fades()).toHaveLength(0);
  });

  it("keeps the settled DOM equal to the FEN through a rapid walk", () => {
    for (let i = 0; i < 12; i += 1) {
      const next = i % 2 === 0 ? AFTER_E4_C6 : AFTER_E4;
      step(next, next === AFTER_E4_C6 ? "c7c6" : "e2e4", true);
      // Whatever overlapped, every square holds exactly its own piece and no
      // capture clone outlives the position it was drawn for.
      const wrong = [];
      const pieces = parseFenBoard(next);
      for (const [name, sq] of board.squares) {
        const want = pieces[name] || "";
        const ownCount = sq.children.filter((c) => c.className.split(" ").includes("piece") && !c.className.includes("piece-caught")).length;
        if (ownCount !== (want ? 1 : 0)) wrong.push(`${name}: ${ownCount} pieces, want ${want ? 1 : 0}`);
        if (sq.dataset.piece !== want) wrong.push(`${name}: data-piece ${sq.dataset.piece} want ${want}`);
        if (caught(name).length) wrong.push(`${name}: stale capture clone`);
      }
      expect(wrong).toEqual([]);
    }
  });

  it("keeps the rewind geometry when the board is flipped", () => {
    board.setOrientation("black");
    layout("black");
    landOnBoard(AFTER_E4, "e2e4");
    step(START_FEN, null);
    // Offsets come from the squares in the orientation on screen, so the travel
    // is right on a flipped board too.
    expect(travelOn("e2")).toBe("translate(0px, 200px)");
    expect(own("e4")).toHaveLength(0);
  });

  it("leaves one running slide per piece when a render interrupts", () => {
    landOnBoard(AFTER_E4, "e2e4");
    // The e4 pawn keeps its element across this render; its new travel replaces
    // the running one rather than stacking a second transform on the piece.
    const runs = own("e4")[0].animations.filter((a) => a.frames?.[0]?.transform);
    step(AFTER_E4_C6, "c7c6");
    step(AFTER_E4, "e2e4");
    expect(runs).toHaveLength(1);
  });

  it("sounds a played move once and stays quiet when told it is a step back", () => {
    sounds.length = 0;
    landOnBoard(AFTER_E4, "e2e4");
    step(AFTER_E4_C6, "c7c6");
    expect(sounds).toEqual(["move", "move"]);
    sounds.length = 0;
    step(AFTER_E4, "e2e4", true); // back: the undone move already sounded
    expect(sounds).toEqual([]);
  });
});
