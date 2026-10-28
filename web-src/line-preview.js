// Move links: what a move inside text does when it is clicked.
//
// A move token (move-text.js markup) is a control: clicking it, or Enter/Space on
// it, acts on the active view's board through the view's own apply handler. Views
// without one (Train, Scout, Games…) leave the token to its row. Beside the Analyze
// board, pointing at a move shows its position on that board (see "Peek" below).
import { decodeLine, previewPosition } from "./move-text.js";

// A token carries its line, or sits inside an element that does (a game's move list).
/** What a token names: `{ fen, lastMove, label, line, ply }`, or null if it is not a move. */
export function tokenPosition(el) {
  if (!el?.closest) return null;
  const holder = el.closest("[data-mt]");
  if (!holder || !el.dataset?.p) return null;
  const line = decodeLine(holder.dataset.mt);
  const ply = Number(el.dataset.p) + 1;
  if (!line || line.plies.length < ply) return null;
  return { ...previewPosition(line, ply), label: line.plies[ply - 1].label, line, ply };
}

let apply = () => null;

// A token is its own control; a token inside a clickable row is the row's, and
// only `.move-ref` (the focusable kind) is handled here.
function act(target) {
  const run = apply(target);
  if (!run) return false;
  run();
  return true;
}

// --- Peek ------------------------------------------------------------------
// A move named beside the board (the coach's sentence or an engine line in
// Analyze, a next-move chip in Build) shows its position on that board while the
// reader points at it: the board
// tints and the pieces stand where the move leaves them; leaving puts the real
// position back. On touch there is no hover, so a tap peeks and a second tap (or a
// tap anywhere else) ends it; a reference is then a look, not a jump.
const PEEK_TOKEN = "#coach-prose [data-mt][data-p], #analysis-engine-slot [data-mt] [data-p], #build-branchbar [data-mt][data-p]";
const PEEK_SCOPE = "#coach-prose, #analysis-engine-slot #engine-window-pvs, #build-branchbar";
let peekBoard = () => null;
let peekToken = null; // the token whose position the board shows, if any
let peekScope = null;
let peekPinned = false; // a touch keeps its peek until its own second tap

function showPeek(token) {
  const board = peekBoard();
  const pos = tokenPosition(token);
  if (!board || !pos?.fen) return false;
  board.peek(pos);
  peekToken = token;
  peekScope = token.closest?.(PEEK_SCOPE);
  return true;
}

/** End a peek (also when the text that named it is rewritten). */
export function clearPeek(owner = null) {
  if (!peekToken || (owner && !owner.contains(peekToken))) return;
  peekBoard()?.peek(null);
  peekToken = null;
  peekScope = null;
  peekPinned = false;
}

// Touch: the same token again clears; another token moves the peek to it.
function tapPeek(token) {
  if (peekToken === token) {
    clearPeek();
    return true;
  }
  peekPinned = showPeek(token);
  return peekPinned;
}

const isTouch = (event) => event.pointerType === "touch";

/** Follow move references beside the board. `board()` names the active view's board. */
export function initPeeks(board) {
  peekBoard = board;
  const doc = document;
  // A sentence/variation is one reading area: gaps between moves keep the last
  // preview, and the next move replaces it directly. Leaving that area ends it.
  // Engine rows repaint under a resting pointer, so leaving is read
  // from where the pointer goes, not from the token it left. A repaint under a
  // pointer that has not moved fires pointerover too; that is not the reader
  // pointing at anything, so it neither starts nor ends a peek (a game step
  // with the mouse resting on an engine line shows the game, not the line).
  let lastAt = "";
  doc.addEventListener("pointermove", (event) => { lastAt = `${event.clientX},${event.clientY}`; });
  doc.addEventListener("pointerover", (event) => {
    if (isTouch(event) || peekPinned || `${event.clientX},${event.clientY}` === lastAt) return;
    const token = event.target.closest?.(PEEK_TOKEN);
    if (token) {
      if (token !== peekToken) showPeek(token);
    } else if (!peekScope?.contains(event.target)) {
      clearPeek();
    }
  });
  doc.addEventListener("focusin", (event) => {
    const token = event.target.closest?.(PEEK_TOKEN);
    if (token && token.matches?.(":focus-visible") && !peekPinned) showPeek(token);
  });
  doc.addEventListener("focusout", (event) => {
    if (!peekToken || event.target.closest?.(PEEK_TOKEN) !== peekToken || peekPinned) return;
    const next = event.relatedTarget?.closest?.(PEEK_TOKEN);
    if (next) showPeek(next); else clearPeek();
  });
  doc.addEventListener("pointerleave", () => { if (!peekPinned) clearPeek(); });
  doc.addEventListener("pointerdown", (event) => {
    if (peekPinned && !event.target.closest?.(PEEK_TOKEN)) clearPeek();
  }, true);
}

/**
 * Install the delegated listeners once. `apply(token)` returns a function that acts
 * on the active view's board for that token, or null where the view has none.
 */
export function initMoveLinks({ apply: applyFn = () => null } = {}) {
  apply = applyFn;
  const doc = document;
  let lastPointer = "mouse";
  doc.addEventListener("pointerdown", (event) => { lastPointer = event.pointerType || "mouse"; }, true);
  // Capture: a token inside a clickable row (a Scout line) is its own control.
  doc.addEventListener("click", (event) => {
    const target = event.target.closest?.(".move-ref[data-p]");
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    // A coach reference tapped on a phone is a peek; everywhere else, and on a
    // mouse, the click does what it always did.
    if (lastPointer === "touch" && target.matches?.("#coach-prose [data-mt][data-p]") && tapPeek(target)) return;
    act(target);
  }, true);
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest?.(".move-ref[data-p]");
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    act(target);
  }, true);
}
