// The board bar's one text slot, and what an engine line puts in it while it is
// walked on the board. Analyze's bar names the game (board-caption.js) and
// Build's names the move trail, so a line being previewed takes the slot over —
// with the bar's accent, see .board-bar:has(.pv-exit) — and both come back when
// it closes. A phone reads the position in its eval row instead, because its
// thumb bar carries the Analyze action; that row follows the line too.
import { setPositionCaption } from "../board-caption.js";

export function takePreviewCaption(view) {
  const analyze = view !== "build";
  return {
    label: document.getElementById(analyze ? "analysis-board-caption" : "build-board-label"),
    exit: document.getElementById(analyze ? "analysis-pv-exit" : "build-pv-exit"),
    // The phone's copy of the position, only where the bar has no room for it.
    position: analyze ? document.getElementById("analysis-ev-move") : null,
    saved: null,
  };
}

export function setPreviewCaption(slot, text) {
  if (!slot) return;
  if (slot.label) {
    // The line's first ply is where the bar's own text is still saved.
    slot.saved ||= { text: slot.label.textContent, title: slot.label.title, position: slot.position?.textContent || "" };
    slot.label.textContent = text;
    slot.label.title = text;
  }
  if (slot.position) setPositionCaption(text);
  if (slot.exit) slot.exit.hidden = false;
}

// `restored` is false when a new real position replaced the preview: the caller
// labels that position itself, so only the exit control goes away.
export function releasePreviewCaption(slot, restored) {
  if (!slot) return;
  if (slot.exit) slot.exit.hidden = true;
  if (!restored || !slot.saved) return;
  if (slot.label) {
    slot.label.textContent = slot.saved.text;
    slot.label.title = slot.saved.title;
  }
  if (slot.position) slot.position.textContent = slot.saved.position;
  slot.saved = null;
}
