import { parseFenBoard } from "./ui.js";

// A move is the app's most repeated action, so its motion has one budget:
// 140ms, transform and opacity only, and nothing at all under reduced motion.
// The eye must never wait on a move.
export const MOVE_SLIDE_MS = 140;

// Reduced motion keeps the state change and drops the travel: the piece appears
// where it landed, and a captured piece is simply gone. Read per move, so
// changing the OS setting needs no reload.
export function prefersReducedMotion() {
  return Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

// The position a FEN names, without its clocks. The board's own moves are
// computed locally (chess.js) and the confirmed position comes from the server
// (python-chess), which disagree on the halfmove and en-passant fields; the same
// position then arrives twice with two different strings. Everything that asks
// "did the position change?" (the drawn marks, one move's one sound) asks this.
export function positionKey(fen) {
  return String(fen || "").split(" ").slice(0, 4).join(" ");
}

// The square the captured piece stood on, or null when the move took nothing.
// Read from the two positions rather than from the move, so it is right for an
// ordinary capture and for en passant, and stays silent when the board jumped
// somewhere unrelated instead of playing one move.
export function capturedSquare(prevFen, fen, from, to) {
  let before;
  let after;
  try {
    before = parseFenBoard(prevFen);
    after = parseFenBoard(fen);
  } catch (_) {
    return null;
  }
  // The mover really went there, and exactly one piece left the board. A
  // promotion changes the mover's letter on arrival, so compare caselessly.
  if (!before[from] || String(after[to]).toLowerCase() !== before[from].toLowerCase()) return null;
  if (Object.keys(before).length - Object.keys(after).length !== 1) return null;
  // Ordinary capture: the destination held the other side's piece.
  if (before[to]) return to;
  // En passant: the pawn stepped onto an empty square and took the pawn beside
  // it — same rank as where it came from, same file as where it went.
  const beside = `${to[0]}${from[1]}`;
  return before[beside] ? beside : null;
}

// A detached copy of the piece on `square` (a live element), ready to be mounted
// on that square after the position re-renders. Cloning it before the render is
// what lets a capture be seen at all: the render wipes the original at frame zero.
// The square's OWN piece is the source, never a capture clone fading out over it
// from the previous move.
export function caughtPiece(squareEl) {
  const source = squareEl?.querySelector(".piece:not(.piece-caught)");
  if (!source) return null;
  const copy = source.cloneNode(true);
  copy.classList.add("piece-caught");
  return copy;
}

// The slide itself. `slide` is { dx, dy, to } read before any DOM write; the
// mover animates from the square it came from into its own.
//
// It runs on the Web Animations API rather than a CSS transition. The old code
// flushed the start state with `void piece.offsetWidth`, but a piece is an
// <svg>, which has no offsetWidth at all: the flush did nothing, the start and
// end transforms collapsed into one write, and every move landed as a jump. A
// keyframe animation needs no flush — it has its own start state.
export function slidePiece({ dx, dy, to }, squareOf, caught = null) {
  if (prefersReducedMotion()) {
    caught?.remove();
    return;
  }
  const piece = squareOf(to)?.querySelector(".piece");
  if (!piece) {
    caught?.remove();
    return;
  }
  piece.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
    { duration: MOVE_SLIDE_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  );
  if (!caught) return;
  // The victim stays whole while the mover travels, so the exchange is legible,
  // and goes in the last third as the mover arrives. Fading from the first
  // frame looked as if the piece was never there.
  const fade = caught.animate(
    [{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.6 }, { opacity: 0, offset: 1 }],
    { duration: MOVE_SLIDE_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  );
  fade.onfinish = () => caught.remove();
}
