// A capture is the one board moment where two pieces are involved, and it used
// to show only one: the position re-rendered first, so the taken piece was gone
// before the capturing piece had travelled a pixel and the eye saw a piece
// arrive into an already-empty square.
//
// It also never travelled at all. The slide flushed its start state with
// `void piece.offsetWidth`, and a piece is an <svg>, which has no offsetWidth:
// every move landed as a jump. Both are fixed in board/move-motion.js, and the
// board's move animation is the app's most repeated one, so it stays inside the
// repeated-action budget.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MOVE_SLIDE_MS, capturedSquare, caughtPiece, slidePiece } from "./board/move-motion.js";

const controller = readFileSync(new URL("./board/board-controller.js", import.meta.url), "utf8");
const motion = readFileSync(new URL("./board/move-motion.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

// A tiny stand-in for the board's square map and an element with .animate.
function fakePiece() {
  const calls = [];
  return {
    calls,
    classList: { add: (name) => calls.push(["class", name]) },
    cloneNode: () => fakePiece(),
    animate: (frames, opts) => {
      calls.push(["animate", frames, opts]);
      return { set onfinish(fn) { calls.push(["onfinish", fn]); }, get onfinish() { return null; } };
    },
    remove: () => calls.push(["remove"]),
  };
}

describe("the board's move motion", () => {
  it("stays inside the repeated-action budget", () => {
    expect(MOVE_SLIDE_MS).toBeLessThanOrEqual(150);
  });

  it("animates the mover with keyframes, not a CSS transition", () => {
    // No forced reflow: a keyframe animation carries its own start state.
    const piece = fakePiece();
    slidePiece({ dx: 40, dy: 0, to: "e4" }, () => ({ querySelector: () => piece }));
    const anim = piece.calls.find((c) => c[0] === "animate");
    expect(anim[1]).toEqual([{ transform: "translate(40px, 0px)" }, { transform: "translate(0, 0)" }]);
    expect(anim[2].duration).toBe(MOVE_SLIDE_MS);
    // The old slide's flush. `offsetWidth` is undefined on a piece <svg>, so it
    // never ran; nothing may reintroduce it as the way to land a move.
    const code = motion.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("offsetWidth");
  });

  it("holds the captured piece and lets it go as the mover arrives", () => {
    const caught = fakePiece();
    slidePiece({ dx: 40, dy: 0, to: "e4" }, () => ({ querySelector: () => fakePiece() }), caught);
    const fade = caught.calls.find((c) => c[0] === "animate");
    expect(fade[1]).toEqual([
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: 0.6 },
      { opacity: 0, offset: 1 },
    ]);
    // Removed when the fade ends, never on a timer that could outlive the board.
    const finish = caught.calls.find((c) => c[0] === "onfinish")[1];
    finish();
    expect(caught.calls.at(-1)).toEqual(["remove"]);
  });

  it("drops the held piece at once when reduced motion is asked for", () => {
    const original = globalThis.matchMedia;
    globalThis.matchMedia = () => ({ matches: true });
    const caught = fakePiece();
    slidePiece({ dx: 40, dy: 0, to: "e4" }, () => ({ querySelector: () => fakePiece() }), caught);
    globalThis.matchMedia = original;
    expect(caught.calls).toEqual([["remove"]]);
  });

  it("finds an ordinary capture's square", () => {
    const before = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const after = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
    expect(capturedSquare(before, after, "e4", "d5")).toBe("d5");
  });

  it("finds the pawn en passant takes, which is beside the destination", () => {
    // Black's e4 pawn captures to d3, taking White's pawn on d4: same rank as
    // where the mover came from, same file as where it lands.
    const before = "rnbqkbnr/ppp1pppp/8/8/3Pp3/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 3";
    const after = "rnbqkbnr/ppp1pppp/8/8/8/3P4/PPP1PPPP/RNBQKBNR b KQkq - 0 4";
    expect(capturedSquare(before, after, "e4", "d3")).toBe("d4");
  });

  it("is silent for a move that took nothing", () => {
    const before = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const after = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    expect(capturedSquare(before, after, "e2", "e4")).toBeNull();
  });

  it("is silent for a jump between unrelated positions", () => {
    // Two pieces gone at once is not a capture on its way to this position.
    const before = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const after = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";
    expect(capturedSquare(before, after, "e4", "d5")).toBeNull();
  });

  it("clones the victim detached, so the render cannot mistake it for the square's piece", () => {
    const square = { querySelector: () => fakePiece() };
    const copy = caughtPiece(square);
    expect(copy.classList.add).toBeTypeOf("function");
    // The copy is not mounted by the clone helper; setPosition mounts it later.
    expect(motion).toMatch(/export function caughtPiece/);
    expect(controller).toMatch(/caughtPiece\(this\.squares\.get\(slide\.capturedAt\)\)/);
  });

  it("places the held piece over its square without moving the layout", () => {
    const rule = /\.piece-caught \{([^}]*)\}/.exec(css)[1];
    expect(rule).toContain("position: absolute");
    expect(rule).not.toMatch(/width:|height:|top:|left:/);
  });
});
