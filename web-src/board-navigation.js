// Chessboard arrow-key navigation (roving focus geometry).
//
// The board keeps a roving tabindex (one square focusable, the rest
// tabindex="-1"), so arrow keys must move the DOM focus instead of scrolling
// the page. This module holds the pure geometry — which square sits in the
// pressed direction — so app.js's BoardController only wires focus and the
// tests can pin the math (including the flipped-board case) without a DOM.

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/**
 * Which square lies in the pressed direction from `fromSquare` on a board
 * showing `orientation`.
 *
 * Directions are screen directions: ArrowLeft/Right are the on-screen
 * left/right FILES, ArrowUp/Down the on-screen ranks. A flipped board
 * (orientation "black") renders ranks 1→8 and files h→a from the top-left,
 * so Up/Down invert and Left/Right swap file direction too — the geometry
 * must follow what the eyes see, not the board coordinates.
 *
 * Returns the square name, or null at the board edge (the controller leaves
 * focus where it is — no wrap-around, matching grid-widget conventions).
 *
 * @param {string} fromSquare e.g. "e2"
 * @param {string} key one of ArrowUp | ArrowDown | ArrowLeft | ArrowRight
 * @param {"white" | "black"} orientation board orientation
 * @returns {string | null}
 */
export function squareInDirection(fromSquare, key, orientation = "white") {
  const from = typeof fromSquare === "string" ? fromSquare.trim().toLowerCase() : "";
  if (!/^[a-h][1-8]$/.test(from)) return null;
  const fileIndex = FILES.indexOf(from[0]);
  const rank = Number(from[1]);

  let fileStep;
  let rankStep;
  switch (key) {
    case "ArrowLeft":
      fileStep = -1;
      rankStep = 0;
      break;
    case "ArrowRight":
      fileStep = 1;
      rankStep = 0;
      break;
    case "ArrowUp":
      fileStep = 0;
      rankStep = orientation === "black" ? -1 : 1;
      break;
    case "ArrowDown":
      fileStep = 0;
      rankStep = orientation === "black" ? 1 : -1;
      break;
    default:
      return null;
  }

  // On a flipped board the file strip is mirrored on screen: h-file sits on
  // the visual left, so the visual left (ArrowLeft) is the NEXT file letter.
  const fileSign = orientation === "black" ? -fileStep : fileStep;
  const nextFile = fileIndex + fileSign;
  const nextRank = rank + rankStep;
  if (nextFile < 0 || nextFile > 7 || nextRank < 1 || nextRank > 8) return null;
  return `${FILES[nextFile]}${nextRank}`;
}
