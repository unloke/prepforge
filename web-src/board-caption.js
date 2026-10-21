// The Analyze board bar's caption (the one line under the board) and the
// position text a phone reads in its eval row. Two different facts, two
// different places: the bar names the game on the board; the eval row says
// which position of it is showing, because a phone has no room under the board
// and its thumb bar carries the Analyze action instead.
//
// The bar truncates with an ellipsis, so the full name is also the tooltip: a
// long game stays readable without widening the bar or growing it a line.
export function setBoardCaption(text) {
  const el = document.getElementById("analysis-board-caption");
  if (!el) return;
  el.textContent = text || "";
  el.title = text || "";
}

export function setPositionCaption(text) {
  const el = document.getElementById("analysis-ev-move");
  if (el) el.textContent = text || "";
}
