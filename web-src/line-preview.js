// Move links: what a move inside text does when it is clicked.
//
// boardLine: a line walked on a view's own board (engine PVs, a note's line, a
// coverage gap). The real position is saved on entry and put back on exit; ◀ ▶ /
// ← → step, Esc or "Exit line" leaves. The game, the analysis tree and the
// repertoire are never touched. One line at a time, whoever opened it.
//
// A move token (move-text.js markup) is a control: clicking it, or Enter/Space on
// it, acts on the active view's board through the view's own apply handler. Views
// without one (Train, Scout, Games…) leave the token to its row. Nothing hovers a
// board beside the text any more: the coach's sentence draws its line on the board
// the reader is already looking at (coach-ghost.js).
import { decodeLine, clampPly, previewLabel, previewPosition, stepPreview } from "./move-text.js";
import { releasePreviewCaption, setPreviewCaption, takePreviewCaption } from "./controllers/preview-caption.js";

let session = null;

function endedSession(restored) {
  const s = session;
  if (!s) return;
  session = null;
  releasePreviewCaption(s.caption, restored);
  s.onChange?.(null);
}

function showSession() {
  const s = session;
  s.board.showPreview(previewPosition(s.line, s.ply));
  setPreviewCaption(s.caption, previewLabel(s.line, s.ply, s.name));
  s.onChange?.(s);
}

export const boardLine = {
  /** Walk `line` (move-text walkLine shape) on `board` at `ply`; `onChange(s|null)` follows it. */
  open({ board, view, line, ply = 1, name = "Line", owner = null, onChange = null }) {
    if (!board || !line) return;
    if (session && session.board !== board) this.exit();
    if (session && session.owner !== owner) {
      // Another source takes the same board over: the board stays in preview.
      const prev = session.onChange;
      session.onChange = null;
      prev?.(null);
    }
    if (!session) {
      board.beginPreview({ onEnd: ({ restored }) => endedSession(restored) });
      session = { caption: takePreviewCaption(view) };
    }
    Object.assign(session, { board, line, name, owner, onChange, ply: clampPly(line, ply) });
    showSession();
  },
  /** Step the open line; false when none is open. */
  step(action) {
    if (!session) return false;
    session.ply = stepPreview(session.line, session.ply, action);
    showSession();
    return true;
  },
  exit() {
    session?.board.endPreview({ restore: true });
  },
  get active() {
    return session;
  },
};

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

// --- The coach's ghost -------------------------------------------------------
// The coach card's sentences are the one place a move reference draws its line on
// the board: hovering or focusing "2.Nf3" puts the line the sentence walked on the
// Analyze board as faint arrows, and leaving clears it. The text and the board sit
// side by side, so the answer is on the board itself — nothing floats over the
// panel and no layout moves. On touch there is no hover, so a tap shows the ghost
// and a second tap (or a tap anywhere else) clears it; a coach reference is then a
// look, not a jump.
const GHOST_TOKEN = "#coach-prose [data-mt][data-p]";
let ghostBoard = () => null;
let ghostToken = null; // the token whose line is drawn, if any
let ghostPinned = false; // a touch keeps its ghost until its own second tap

function showGhost(token) {
  const board = ghostBoard();
  const pos = tokenPosition(token);
  if (!board || !pos?.line) return false;
  board.setGhost(pos.line.plies.slice(0, pos.ply).map((p) => p.uci));
  ghostToken = token;
  return true;
}

/** Clear the coach's ghost from the board (also when its sentence is rewritten). */
export function clearCoachGhost() {
  if (!ghostToken) return;
  ghostBoard()?.setGhost([]);
  ghostToken = null;
  ghostPinned = false;
}

// Touch: the same token again clears; another token moves the ghost to it.
function tapGhost(token) {
  if (ghostToken === token) {
    clearCoachGhost();
    return true;
  }
  ghostPinned = showGhost(token);
  return ghostPinned;
}

const isTouch = (event) => event.pointerType === "touch";

/** Follow the coach card's move references. `board()` names the board to draw on. */
export function initCoachGhosts(board) {
  ghostBoard = board;
  const doc = document;
  doc.addEventListener("pointerover", (event) => {
    if (isTouch(event)) return;
    const token = event.target.closest?.(GHOST_TOKEN);
    if (!token || ghostToken === token || ghostPinned) return;
    showGhost(token);
  });
  doc.addEventListener("pointerout", (event) => {
    if (isTouch(event)) return;
    const token = event.target.closest?.(GHOST_TOKEN);
    if (!token || token.contains?.(event.relatedTarget)) return;
    if (ghostToken === token && !ghostPinned) clearCoachGhost();
  });
  doc.addEventListener("focusin", (event) => {
    const token = event.target.closest?.(GHOST_TOKEN);
    if (token && token.matches?.(":focus-visible") && !ghostPinned) showGhost(token);
  });
  doc.addEventListener("focusout", (event) => {
    if (ghostToken && event.target.closest?.(GHOST_TOKEN) === ghostToken && !ghostPinned) clearCoachGhost();
  });
  doc.addEventListener("pointerdown", (event) => {
    if (ghostPinned && !event.target.closest?.(GHOST_TOKEN)) clearCoachGhost();
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
    // A coach reference tapped on a phone is the ghost's; everywhere else, and on
    // a mouse, the click does what it always did.
    if (lastPointer === "touch" && target.matches?.(GHOST_TOKEN) && tapGhost(target)) return;
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
