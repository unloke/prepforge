// Chessboard keyboard square selection (typed coordinates).
//
// The board keeps one tabbable square (the rest tabindex="-1") so it is a
// single Tab stop. Arrow keys are NOT board-local: they belong to the app's
// move navigation (← → step the game) everywhere, including when a square has
// focus. A keyboard user reaches another square by typing its name — a file
// letter then a rank digit ("e4") — and plays with Enter/Space as before.
// This module holds the pure parsing so BoardController only wires focus and
// the tests can pin it without a DOM.

/**
 * Advance the typed-square buffer with one key press.
 *
 * Returns `{ pending, square }`: `pending` is the file letter waiting for its
 * rank (or null), `square` the completed square name (or null). A key that is
 * neither a file letter nor a rank digit after a pending file clears the
 * buffer. Lowercase only: Shift+F stays the board-flip shortcut.
 *
 * @param {string | null} pendingFile file letter typed before, or null
 * @param {string} key the KeyboardEvent.key just pressed
 * @returns {{ pending: string | null, square: string | null, handled: boolean }}
 */
export function typedSquare(pendingFile, key) {
  const k = typeof key === "string" && key.length === 1 ? key : "";
  if (/^[a-h]$/.test(k)) return { pending: k, square: null, handled: true };
  if (pendingFile && /^[a-h]$/.test(pendingFile) && /^[1-8]$/.test(k)) {
    return { pending: null, square: `${pendingFile}${k}`, handled: true };
  }
  return { pending: null, square: null, handled: false };
}
