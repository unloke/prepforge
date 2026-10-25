// The board's motion is derived from the two positions, not from a caller's
// claim about which move happened. A capture is the one board moment where two
// pieces are involved, and a position change does not say which way the user is
// travelling: stepping back through a repertoire is the same pair of positions
// as stepping into it.
//
// The old slide was built from `lastMove` alone, so a step back (only Analyze's
// mainline ever passed `back: true`) replayed the move forward from its origin
// while the piece that had to travel home was re-rendered — a wrong-origin slide
// plus a teleport. And a jump to another line still slid a piece that never stood
// on that origin. These read the pair of positions instead, so every board gets
// the travel home, and a jump is a cut.
import { readFileSync } from "node:fs";

import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";

import {
  MOVE_SLIDE_MS, boardTransition, caughtPiece, moveMotion, playMoveMotion,
} from "./board/move-motion.js";

const controller = readFileSync(new URL("./board/board-controller.js", import.meta.url), "utf8");
const motion = readFileSync(new URL("./board/move-motion.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

// --- the smallest DOM the motion needs --------------------------------------
function pieceElement(name = "piece xy") {
  let classes = name.split(" ");
  const calls = [];
  return {
    calls,
    classList: { add: (c) => classes.push(c) },
    get className() { return classes.join(" "); },
    set className(value) { classes = String(value).split(/\s+/).filter(Boolean); },
    cloneNode() {
      const copy = pieceElement(this.className);
      copy.removed = this.removed;
      return copy;
    },
    animate(frames, opts) {
      const animation = { frames, opts, cancelled: false, cancel() { this.cancelled = true; } };
      calls.push(["animate", animation]);
      return animation;
    },
    remove() { calls.push(["remove"]); this.removed = true; },
  };
}

function squareElement(name, { offsetLeft = 0, offsetTop = 0, piece = null } = {}) {
  const children = [];
  if (piece) children.push(piece);
  return {
    name, offsetLeft, offsetTop, children,
    appendChild(node) { children.push(node); },
    querySelector(sel) {
      const want = sel.replace(/^\./, "").split(":not(")[0];
      const not = /:not\(\.([\w-]+)\)/.exec(sel)?.[1];
      return children.find((c) => c.className.split(" ").includes(want) && !(not && c.className.split(" ").includes(not))) || null;
    },
  };
}

// --- positions (chess.js-verified) ------------------------------------------
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const BEFORE_CAPTURE = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_CAPTURE = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
const BEFORE_EP = "rnbqkbnr/pp1ppppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
const AFTER_EP = "rnbqkbnr/pp1ppppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3";
const BEFORE_CASTLE = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
const AFTER_CASTLE = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4";
const BEFORE_PROMO = "8/P6k/8/8/8/8/6K1/8 w - - 0 1";
const AFTER_PROMO = "Q7/7k/8/8/8/8/6K1/8 b - - 0 1";
// Three plies away from START: a jump, not one move.
const JUMPED = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";

// Real lines, played here so every FEN is complete and legal rather than a
// hand-written placement. `after("e4", "e5")` is the position after 1.e4 e5.
function after(...sans) {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}
// 1.e4 e5 2.Nf3 Nc6, then its two alternatives 3.d4 / 3.d3 (same parent) and
// 3.Bb5 / 3.Bc4 (same parent). Siblings share side to move and fullmove.
const SIBLING_PARENT = after("e4", "e5", "Nf3", "Nc6");
const SIBLING_D4 = after("e4", "e5", "Nf3", "Nc6", "d4");
const SIBLING_D3 = after("e4", "e5", "Nf3", "Nc6", "d3");
const SIBLING_BB5 = after("e4", "e5", "Nf3", "Nc6", "Bb5");
const SIBLING_BC4 = after("e4", "e5", "Nf3", "Nc6", "Bc4");
// 1.d4 d5 2.c4 dxc4: the opponent's reply takes the pawn, so a two-ply takeback
// (Train's ordinary one) removes a capture. After 2...dxc4 the white pawn is on
// c4 and the black pawn on d5; after 1...d5 the white pawn is home on c2 and the
// black pawn is back on d5.
const QGA_AFTER_D5 = after("d4", "d5");
const QGA_AFTER_DXC4 = after("d4", "d5", "c4", "dxc4");
// A delta-1 jump between two different lines: 1.e4 e5 (2 plies) and
// 1.e4 e6 2.d4 (3 plies). The clocks are one apart; the d2 pawn never moved to
// d4 in the first position, so no move explains the change.
const OPEN_E5 = after("e4", "e5");
const OPEN_E6_D4 = after("e4", "e6", "d4");

const pair = (from, to) => ({ from, to });
const squaresOf = (list) => list.map((entry) => entry.square);

describe("the board's move motion", () => {
  it("stays inside the repeated-action budget", () => {
    expect(MOVE_SLIDE_MS).toBeLessThanOrEqual(150);
  });

  it("animates the mover with keyframes, not a CSS transition", () => {
    // No forced reflow: a keyframe animation carries its own start state.
    const piece = pieceElement();
    const plan = moveMotion(boardTransition(AFTER_E4, START), () => ({ offsetLeft: 0, offsetTop: 0 }));
    playMoveMotion(plan, () => squareElement("x", { piece }));
    const anim = piece.calls.find((c) => c[0] === "animate")[1];
    expect(anim.frames).toEqual([{ transform: "translate(0px, 0px)" }, { transform: "translate(0, 0)" }]);
    expect(anim.opts.duration).toBe(MOVE_SLIDE_MS);
    // The old slide's flush. `offsetWidth` is undefined on a piece <svg>, so it
    // never ran; nothing may reintroduce it as the way to land a move.
    const code = motion.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("offsetWidth");
  });

  it("reads what moved from two positions, in either direction", () => {
    expect(boardTransition(START, AFTER_E4)).toEqual({
      movers: [pair("e2", "e4")], gone: [], restored: [],
    });
    // The same pair read backwards: the pawn now goes home.
    expect(boardTransition(AFTER_E4, START)).toEqual({
      movers: [pair("e4", "e2")], gone: [], restored: [],
    });
  });

  it("gives a capture's victim back on the way back", () => {
    expect(boardTransition(BEFORE_CAPTURE, AFTER_CAPTURE)).toEqual({
      movers: [pair("e4", "d5")], gone: ["d5"], restored: [],
    });
    expect(boardTransition(AFTER_CAPTURE, BEFORE_CAPTURE)).toEqual({
      movers: [pair("d5", "e4")], gone: [], restored: ["d5"],
    });
  });

  it("finds the pawn en passant takes, which is beside the destination", () => {
    // The victim stands on d5, not on the d6 the capturing pawn lands on.
    expect(boardTransition(BEFORE_EP, AFTER_EP)).toEqual({
      movers: [pair("e5", "d6")], gone: ["d5"], restored: [],
    });
    expect(boardTransition(AFTER_EP, BEFORE_EP)).toEqual({
      movers: [pair("d6", "e5")], gone: [], restored: ["d5"],
    });
  });

  it("moves both pieces of a castling, in either direction", () => {
    expect(boardTransition(BEFORE_CASTLE, AFTER_CASTLE)).toEqual({
      movers: [pair("e1", "g1"), pair("h1", "f1")], gone: [], restored: [],
    });
    // Deterministic order: board order (file, then rank), so a consumer can
    // rely on the same list for the same pair.
    expect(boardTransition(AFTER_CASTLE, BEFORE_CASTLE)).toEqual({
      movers: [pair("f1", "h1"), pair("g1", "e1")], gone: [], restored: [],
    });
  });

  it("pairs a promoted piece with the pawn that left", () => {
    expect(boardTransition(BEFORE_PROMO, AFTER_PROMO)).toEqual({
      movers: [pair("a7", "a8")], gone: [], restored: [],
    });
    expect(boardTransition(AFTER_PROMO, BEFORE_PROMO)).toEqual({
      movers: [pair("a8", "a7")], gone: [], restored: [],
    });
  });

  it("is a cut when two pieces of the same side would both have to move", () => {
    // 1.e4 c5 and 1.e4 e5 differ by TWO black pawn moves. Pairing them by letter
    // would invent a c5->e5 pawn plus an e7->c7 pawn: no single move does that.
    const afterC5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const afterE5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    expect(boardTransition(afterC5, afterE5)).toBeNull();
    expect(boardTransition(afterE5, afterC5)).toBeNull();
  });

  it("is a cut, not a slide, for a jump between positions", () => {
    // Three plies apart: sliding one of them would draw a move no piece played.
    expect(boardTransition(START, JUMPED)).toBeNull();
    expect(boardTransition(JUMPED, START)).toBeNull();
    // Unrelated positions (a new game, another repertoire).
    expect(boardTransition(START, "4k3/8/8/8/8/8/8/4K3 w - - 0 1")).toBeNull();
    // The same position twice is not a move at all.
    expect(boardTransition(START, START)).toBeNull();
    // 1.Nf3 Nf6 2.Ng1 is three plies, but its net change looks like the one
    // knight move g8->f6. The FEN clocks say three plies, so it is a cut.
    const knightRoundTrip = after("Nf3", "Nf6", "Ng1");
    expect(boardTransition(START, knightRoundTrip)).toBeNull();
    expect(boardTransition(knightRoundTrip, START)).toBeNull();
  });

  it("is a cut between same-ply siblings, whose like pieces pair wrongly", () => {
    // 3.d4 and 3.d3 are two answers from the same parent: the parent's d2 pawn
    // goes to d4 in one and d3 in the other. Read as a change between the two,
    // the after d3 pawn is nearest to d4, so pairing by piece slides it down a
    // rank from a square the pawn never stood on. They share turn and fullmove.
    expect(SIBLING_D4.split(" ").slice(1)).toEqual(SIBLING_D3.split(" ").slice(1));
    expect(boardTransition(SIBLING_PARENT, SIBLING_D4)).toEqual({
      movers: [pair("d2", "d4")], gone: [], restored: [],
    });
    expect(boardTransition(SIBLING_PARENT, SIBLING_D3)).toEqual({
      movers: [pair("d2", "d3")], gone: [], restored: [],
    });
    expect(boardTransition(SIBLING_D4, SIBLING_D3)).toBeNull();
    expect(boardTransition(SIBLING_D3, SIBLING_D4)).toBeNull();
    // The same shape for 3.Bb5 (Ruy Lopez) and 3.Bc4 (Italian): both bishops
    // come from f1, and b5->c4 is not a move between the two positions.
    expect(SIBLING_BB5.split(" ").slice(1)).toEqual(SIBLING_BC4.split(" ").slice(1));
    expect(boardTransition(SIBLING_PARENT, SIBLING_BB5)).toEqual({
      movers: [pair("f1", "b5")], gone: [], restored: [],
    });
    expect(boardTransition(SIBLING_PARENT, SIBLING_BC4)).toEqual({
      movers: [pair("f1", "c4")], gone: [], restored: [],
    });
    expect(boardTransition(SIBLING_BB5, SIBLING_BC4)).toBeNull();
    expect(boardTransition(SIBLING_BC4, SIBLING_BB5)).toBeNull();
  });

  it("animates a two-ply takeback whose last ply was a capture", () => {
    // 2...dxc4 -> 1...d5 is the takeback Train offers after the opponent takes:
    // the pawn travels home to c2 and the taken black pawn fades back in on d5.
    // A clock-only guard dropped this because the capture yields one mover.
    expect(boardTransition(QGA_AFTER_DXC4, QGA_AFTER_D5)).toEqual({
      movers: [pair("c4", "d5")], gone: [], restored: ["c2"],
    });
    // The same two plies read forwards (a repertoire render of the pair).
    expect(boardTransition(QGA_AFTER_D5, QGA_AFTER_DXC4)).toEqual({
      movers: [pair("d5", "c4")], gone: ["c2"], restored: [],
    });
    // A takeback across a capture and its recapture (2.exd5 Qxd5 -> 1.e4 d5):
    // the recapture stands on the square the white pawn left, so the pair is not
    // a slide — the white pawn's home square is not on the board either way.
    expect(boardTransition(after("e4", "d5", "exd5", "Qxd5"), after("e4", "d5"))).toBeNull();
  });

  it("is a cut for a delta-1 jump between two lines", () => {
    // The clocks differ by exactly one ply, so a clock-only proof let this slide
    // d4's pawn all the way from d2 — a square it never left. The move is not
    // legal in the earlier position, so it is a cut in both directions.
    expect(boardTransition(OPEN_E5, OPEN_E6_D4)).toBeNull();
    expect(boardTransition(OPEN_E6_D4, OPEN_E5)).toBeNull();
  });

  it("still animates a child after an ordinary undo to its parent", () => {
    // The guard must not turn a real single move into a cut: from 3.d4 back to
    // the parent the d-pawn leaves d4, and from the parent into the sibling
    // child it travels from d2 to d3. Only the direct sibling jump is cut.
    expect(boardTransition(SIBLING_D4, SIBLING_PARENT)).toEqual({
      movers: [pair("d4", "d2")], gone: [], restored: [],
    });
    expect(boardTransition(SIBLING_PARENT, SIBLING_D3)).toEqual({
      movers: [pair("d2", "d3")], gone: [], restored: [],
    });
    expect(boardTransition(SIBLING_D4, SIBLING_D3)).toBeNull();
    // A bishop: b5 home to f1, then f1 out to c4.
    expect(boardTransition(SIBLING_BB5, SIBLING_PARENT)).toEqual({
      movers: [pair("b5", "f1")], gone: [], restored: [],
    });
    expect(boardTransition(SIBLING_PARENT, SIBLING_BC4)).toEqual({
      movers: [pair("f1", "c4")], gone: [], restored: [],
    });
  });

  it("animates both pieces of a two-ply jump the way they really went", () => {
    // 1.e4 e5 in one render: two pawns moved, and pairing by letter keeps each
    // one on its own file rather than crossing them.
    const twoPly = boardTransition(START, "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
    expect(twoPly.movers).toEqual([pair("e2", "e4"), pair("e7", "e5")]);
  });

  it("reads the travel before the render and holds the victim", () => {
    const victim = pieceElement("piece piece-black");
    const squares = new Map([
      ["e4", squareElement("e4", { offsetLeft: 100, offsetTop: 200, piece: pieceElement() })],
      ["d5", squareElement("d5", { offsetLeft: 0, offsetTop: 0, piece: victim })],
    ]);
    const plan = moveMotion(boardTransition(BEFORE_CAPTURE, AFTER_CAPTURE), (sq) => squares.get(sq));
    // The mover starts where it stood, and the taken piece is already detached.
    expect(plan.slides).toEqual([{ dx: 100, dy: 200, to: "d5" }]);
    expect(plan.held).toHaveLength(1);
    expect(plan.held[0].square).toBe("d5");
    expect(plan.held[0].node.className).toContain("piece-caught");
    expect(plan.restored).toEqual([]);
  });

  it("holds the victim while the mover travels, and lets it go on arrival", () => {
    const victim = pieceElement();
    const landing = squareElement("d5", { piece: pieceElement() });
    const plan = { slides: [{ dx: 40, dy: 0, to: "d5" }], held: [{ square: "d5", node: victim }], restored: [] };
    playMoveMotion(plan, () => landing);
    const fade = victim.calls.find((c) => c[0] === "animate")[1];
    expect(fade.frames).toEqual([
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: 0.6 },
      { opacity: 0, offset: 1 },
    ]);
    // Mounted on its square, never standing in for the square's own piece.
    expect(landing.children).toContain(victim);
    // Removed when the fade ends, never on a timer that could outlive the board.
    fade.onfinish();
    expect(victim.removed).toBe(true);
  });

  it("fades a piece the step back gives back, as the capturer leaves", () => {
    const restoredPiece = pieceElement();
    const plan = { slides: [], held: [], restored: ["d5"] };
    playMoveMotion(plan, () => squareElement("d5", { piece: restoredPiece }));
    const fade = restoredPiece.calls.find((c) => c[0] === "animate")[1];
    // Time-reversed fade-out: it appears while the mover is still travelling.
    expect(fade.frames).toEqual([
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: 0.4 },
      { opacity: 1, offset: 1 },
    ]);
  });

  it("replaces a still-running slide instead of stacking transforms", () => {
    const piece = pieceElement();
    playMoveMotion({ slides: [{ dx: 10, dy: 0, to: "e4" }], held: [], restored: [] },
      () => squareElement("e4", { piece }));
    playMoveMotion({ slides: [{ dx: -10, dy: 0, to: "e4" }], held: [], restored: [] },
      () => squareElement("e4", { piece }));
    const animations = piece.calls.filter((c) => c[0] === "animate").map((c) => c[1]);
    expect(animations).toHaveLength(2);
    expect(animations[0].cancelled).toBe(true);
    expect(animations[1].cancelled).toBe(false);
  });

  it("drops the travel and the held piece at once when reduced motion is asked for", () => {
    const original = globalThis.matchMedia;
    globalThis.matchMedia = () => ({ matches: true });
    const victim = pieceElement();
    const piece = pieceElement();
    playMoveMotion({ slides: [{ dx: 10, dy: 0, to: "d5" }], held: [{ square: "d5", node: victim }], restored: ["d5"] },
      () => squareElement("d5", { piece }));
    globalThis.matchMedia = original;
    expect(victim.removed).toBe(true);
    expect(piece.calls).toEqual([]);
    expect(victim.calls).toEqual([["remove"]]);
  });

  it("drops the held piece when the move animation is switched off", () => {
    const victim = pieceElement();
    playMoveMotion({ slides: [], held: [{ square: "d5", node: victim }], restored: [] }, () => null, false);
    expect(victim.calls).toEqual([["remove"]]);
  });

  it("clones the victim detached, so the render cannot mistake it for the square's piece", () => {
    const own = pieceElement("piece piece-white");
    const fading = pieceElement("piece piece-white piece-caught");
    const square = squareElement("d5", { piece: fading });
    square.appendChild(own);
    const copy = caughtPiece(square);
    expect(copy.className).toContain("piece-caught");
    expect(copy.className).toContain("piece-white");
    expect(caughtPiece(squareElement("e4"))).toBeNull();
    // The copied element's classes came from the OWN piece, not the clone fading
    // out over it from the previous move.
    expect(own.className).toContain("piece-white");
  });

  it("places the held piece over its square without moving the layout", () => {
    const rule = /\.piece-caught \{([^}]*)\}/.exec(css)[1];
    expect(rule).toContain("position: absolute");
    expect(rule).not.toMatch(/width:|height:|top:|left:/);
  });

  it("keeps the controller off `lastMove` for the travel", () => {
    // One implementation: setPosition asks the positions, so no caller has to
    // say which way the board went.
    expect(controller).toMatch(/boardTransition\(prevFen, fen\)/);
    expect(controller).not.toMatch(/slidePiece\(/);
    expect(controller).not.toMatch(/capturedSquare\(/);
  });
});
