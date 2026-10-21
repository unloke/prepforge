import { Chess } from "chess.js";

import { parseFenBoard } from "./ui.js";

// A move is the app's most repeated action, so its motion has one budget:
// 140ms, transform and opacity only, and nothing at all under reduced motion.
// The eye must never wait on a move.
export const MOVE_SLIDE_MS = 140;
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

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

const FILES = "abcdefgh";
const colour = (letter) => (letter === letter.toUpperCase() ? "white" : "black");

// Squares between two points of the same piece, used only to pair two like
// pieces that both moved inside one change (a two-ply jump): the nearest pairing
// is the one the eye can follow, so two knights never cross.
function gap(from, to) {
  return (
    Math.abs(FILES.indexOf(from[0]) - FILES.indexOf(to[0])) +
    Math.abs(Number(from[1]) - Number(to[1]))
  );
}

// How many half-moves the FEN says have been played, from the two clock fields
// chess.js and python-chess write the same way: the side to move and the
// fullmove number. (They differ on the halfmove clock and the en-passant square,
// so those are not read.) A FEN without usable clocks answers null.
function pliesPlayed(fen) {
  const fields = String(fen || "").trim().split(/\s+/);
  const fullmove = Number(fields[5]);
  if (fields[1] !== "w" && fields[1] !== "b") return null;
  if (!Number.isInteger(fullmove) || fullmove < 1) return null;
  return (fullmove - 1) * 2 + (fields[1] === "b" ? 1 : 0);
}

// A move for chess.js, with the promotion letter the later placement shows when a
// pawn reaches the last rank: the arriving piece is what names the promotion.
function stepTo(earlier, later, from, to) {
  const piece = earlier[from];
  const promotion = piece && piece.toLowerCase() === "p" && (to[1] === "1" || to[1] === "8")
    ? (later[to] || "q").toLowerCase()
    : undefined;
  return { from, to, promotion };
}

// Proof that `moves` really lead from the earlier position to the later one. The
// moves are played on a local chess.js board (synchronous, no network, already in
// the bundle) and the placement that comes out must be the later placement. Only
// the placement is compared: the two engines disagree on the clock fields, and
// chess.js moves the rook with its king, so a castling is proved by the king's
// move alone.
function playsOut(earlierFen, laterFen, moves) {
  let chess;
  try {
    chess = new Chess(earlierFen);
    for (const { from, to, promotion } of moves) chess.move({ from, to, promotion });
  } catch (_) {
    return false;
  }
  const reached = parseFenBoard(chess.fen());
  const want = parseFenBoard(laterFen);
  for (const square of new Set([...Object.keys(reached), ...Object.keys(want)])) {
    if (reached[square] !== want[square]) return false;
  }
  return true;
}

// What one position change moved, read off the two placements rather than from
// what the caller says happened.
//
// Every board knows the position it shows but not, in general, which way the
// user is travelling: stepping back through a repertoire is the same pair of
// positions as stepping into it. Reading the pair answers both. Each piece is
// paired with the square it stands on now, so a step back sends it home — `from`
// is where it is on screen before the render, `to` where it lands — instead of
// replaying the move forward from a square it already left. A pair that is not
// one move (a jump to another line, a new game) returns null: it is drawn as a
// cut, never as a slide from a square no piece ever stood on.
//
//   movers   pieces that travel; castling yields king and rook
//   gone     squares whose piece this change removes (a capture)
//   restored squares where a piece comes back (the same capture, stepped back)
export function boardTransition(prevFen, fen) {
  let before;
  let after;
  try {
    before = parseFenBoard(prevFen);
    after = parseFenBoard(fen);
  } catch (_) {
    return null;
  }
  const sources = []; // a piece that is not on this square any more
  const targets = []; // a piece that is on this square now
  for (const square of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[square];
    const now = after[square];
    if (was === now) continue;
    // A square that changed hands is both: the victim left, the mover arrived.
    if (was && (!now || colour(was) !== colour(now))) sources.push({ square, piece: was });
    if (now) targets.push({ square, piece: now });
  }
  // Pair by what the piece is. A promotion arrives as a different letter (and a
  // different kind), so it is left over for the second pass.
  const movers = [];
  const used = new Set();
  for (const target of targets) {
    const same = sources.filter((source, index) => !used.has(index) && source.piece === target.piece);
    if (!same.length) continue;
    const from = same.reduce((best, candidate) =>
      gap(candidate.square, target.square) < gap(best.square, target.square) ? candidate : best);
    used.add(sources.indexOf(from));
    movers.push({ from: from.square, to: target.square });
  }
  // A promotion: the pawn that left and the piece now standing where it went,
  // the one same-colour source and target with no letter to pair them.
  for (const target of targets.filter((t) => !movers.some((mover) => mover.to === t.square))) {
    const same = sources.filter((source, index) =>
      !used.has(index) && colour(source.piece) === colour(target.piece));
    if (same.length !== 1) continue;
    used.add(sources.indexOf(same[0]));
    movers.push({ from: same[0].square, to: target.square });
  }
  const gone = sources.filter((_, index) => !used.has(index)).map((source) => source.square);
  const restored = targets
    .filter((target) => !movers.some((mover) => mover.to === target.square))
    .map((target) => target.square);
  // One move moves one piece, or a king with its own rook. Two movers of the
  // same colour that are not a king and a rook is two moves — a jump between
  // lines, which must be a cut rather than a slide of a piece no one moved.
  // (Two plies of the same game do arrive together: then the two movers are of
  // opposite colours, which is a real change to animate.)
  const letters = movers.map((mover) => before[mover.from]).sort();
  if (movers.length > 1 && colour(letters[0]) === colour(letters[1]) &&
      !(letters[0].toLowerCase() === "k" && letters[1].toLowerCase() === "r")) return null;
  // One move touches at most four squares (castling) and adds or removes one
  // piece; anything wider is a jump.
  if (!movers.length || movers.length > 2 || gone.length > 1 || restored.length > 1) return null;
  if (sources.length + targets.length > 4) return null;
  // The change must be a move, not a jump. The FEN clocks say which position came
  // first and how far apart they are — never that the move between them is legal.
  // They bound the work; the proof is a local chess.js replay from the earlier
  // position, whose placement must be the later one. This is what stops a
  // delta-1 jump between two lines (1.e4 e5 -> 1.e4 e6 2.d4), where pairing by
  // piece happily invents d2->d4, and it is what separates a same-ply sibling
  // pair (3.d4 / 3.d3: no move between them) from a real step. The pair of
  // positions a board shows is the same pair whichever way the user travels, so
  // the replay is chronological and the animation keeps its own direction.
  const beforePlies = pliesPlayed(prevFen);
  const afterPlies = pliesPlayed(fen);
  if (beforePlies === null || afterPlies === null) return null;
  const plies = Math.abs(afterPlies - beforePlies);
  if (plies !== 1 && plies !== 2) return null;
  const forward = afterPlies > beforePlies; // the render plays the move forward
  const earlierBoard = forward ? before : after;
  const laterBoard = forward ? after : before;
  const earlierFen = forward ? prevFen : fen;
  const laterFen = forward ? fen : prevFen;
  const ply = (mover) => stepTo(
    earlierBoard, laterBoard,
    forward ? mover.from : mover.to, forward ? mover.to : mover.from,
  );
  let proved;
  if (plies === 1) {
    // Castling arrives as the king and its rook; chess.js moves the rook with the
    // king, so the king's own move is the one that is played.
    const king = movers.find((mover) =>
      String(before[mover.from] || after[mover.to]).toLowerCase() === "k");
    proved = playsOut(earlierFen, laterFen, [ply(king || movers[0])]);
  } else if (movers.length === 2) {
    // Two plain moves, one from each side. Both orders are tried: the earlier
    // position alone says which side begins, and reaching the later placement is
    // the proof either way.
    const [first, second] = movers.map(ply);
    proved = playsOut(earlierFen, laterFen, [first, second]) ||
      playsOut(earlierFen, laterFen, [second, first]);
  } else if (movers.length === 1 && (forward ? gone.length === 1 : restored.length === 1)) {
    // A two-ply change whose second ply was a capture: the taken piece stood on
    // the square that is now empty and its own move took it to the square the
    // capturer leaves (a step back: the capturer's square), and then it was
    // taken. This is Train's ordinary takeback (1.d4 d5 2.c4 dxc4 -> 1...d5),
    // where the pawn goes home and the taken pawn fades back in — and, read the
    // other way, a forward render of the same two plies.
    const captured = forward ? gone[0] : restored[0];
    proved = playsOut(earlierFen, laterFen, [
      stepTo(earlierBoard, laterBoard, captured, forward ? movers[0].to : movers[0].from),
      ply(movers[0]),
    ]);
  }
  if (!proved) return null;
  // Board order, so the same pair of positions always yields the same list.
  const place = (square) => FILES.indexOf(square[0]) * 8 + Number(square[1]);
  movers.sort((a, b) => place(a.from) - place(b.from));
  return { movers, gone, restored };
}

// A detached copy of the piece on `square` (a live element), ready to be mounted
// there after the position re-renders. Cloning it before the render is what lets
// a capture be seen at all: the render wipes the original at frame zero. The
// square's OWN piece is the source, never a capture clone fading out over it
// from the previous move.
export function caughtPiece(squareEl) {
  const source = squareEl?.querySelector(".piece:not(.piece-caught)");
  if (!source) return null;
  const copy = source.cloneNode(true);
  copy.classList.add("piece-caught");
  return copy;
}

// Read the travel and take the copies the next render will wipe, BEFORE the DOM
// is written: the offsets off the current squares (no forced reflow), and one
// clone of every piece this change removes, so an exchange stays legible while
// the mover arrives.
export function moveMotion({ movers, gone, restored }, squareOf) {
  const slides = [];
  for (const { from, to } of movers) {
    const standing = squareOf(from);
    const landing = squareOf(to);
    if (!standing || !landing) continue;
    slides.push({
      dx: standing.offsetLeft - landing.offsetLeft,
      dy: standing.offsetTop - landing.offsetTop,
      to,
    });
  }
  const held = gone
    .map((square) => ({ square, node: caughtPiece(squareOf(square)) }))
    .filter((entry) => entry.node);
  return { slides, held, restored };
}

const FADE_OUT = [
  { opacity: 1, offset: 0 },
  // The victim stays whole while the mover travels, so the exchange is legible,
  // and goes in the last third as the mover arrives. Fading from the first frame
  // looked as if the piece was never there.
  { opacity: 1, offset: 0.6 },
  { opacity: 0, offset: 1 },
];
// The same fade played back: a piece a step back gives back arrives as the
// capturer leaves, instead of materialising underneath it.
const FADE_IN = [
  { opacity: 0, offset: 0 },
  { opacity: 1, offset: 0.4 },
  { opacity: 1, offset: 1 },
];

// The slide itself. Every slide is placed off the FINAL position, so a render
// that interrupts this one (a held ← / →) can only ever start the next motion
// from a square that exists — and a piece that is still travelling has its
// running transform replaced, never stacked.
export function playMoveMotion({ slides, held, restored }, squareOf, enabled = true) {
  const travel = enabled && !prefersReducedMotion();
  for (const { square, node } of held) {
    if (!travel) {
      node.remove();
      continue;
    }
    squareOf(square)?.appendChild(node);
    const fade = node.animate(FADE_OUT, { duration: MOVE_SLIDE_MS, easing: EASE });
    fade.onfinish = () => node.remove();
  }
  if (!travel) return;
  for (const { dx, dy, to } of slides) {
    const piece = squareOf(to)?.querySelector(".piece:not(.piece-caught)");
    if (!piece) continue;
    piece.getAnimations?.().forEach((running) => running.cancel());
    piece.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
      { duration: MOVE_SLIDE_MS, easing: EASE },
    );
  }
  for (const square of restored) {
    const piece = squareOf(square)?.querySelector(".piece:not(.piece-caught)");
    piece?.animate(FADE_IN, { duration: MOVE_SLIDE_MS, easing: EASE });
  }
}
