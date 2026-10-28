// Practice game session helpers. Pure: history + color + PGN, no DOM.

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function sideToMove(fen) {
  return String(fen || "").split(/\s+/)[1] === "b" ? "black" : "white";
}

export function resolvePlayColor({
  book = "explorer",
  pickerColor = "white",
  repertoireColor = "white",
  repertoireColors = null,
  availableColors = null,
  luckyFen = null,
} = {}) {
  if (luckyFen) return sideToMove(luckyFen);
  if (book === "repertoire") {
    const colors = Array.isArray(repertoireColors)
      ? repertoireColors
      : Array.isArray(availableColors)
        ? availableColors
        : [repertoireColor];
    const normalized = [...new Set(colors.map((color) => (color === "black" ? "black" : "white")))];
    if (normalized.length === 1) return normalized[0];
    return pickerColor === "black" ? "black" : "white";
  }
  return pickerColor === "black" ? "black" : "white";
}

export function formatPlayTrail(history, startFen = START_FEN) {
  const moves = Array.isArray(history) ? history : [];
  if (!moves.length) return "";
  const parts = String(startFen || START_FEN).trim().split(/\s+/);
  let full = Number(parts[5]) || 1;
  let side = parts[1] === "b" ? "b" : "w";
  const out = [];
  for (const ply of moves) {
    const san = ply && ply.san;
    if (!san) continue;
    if (side === "w") out.push(`${full}. ${san}`);
    else out.push(san);
    if (side === "b") full += 1;
    side = side === "w" ? "b" : "w";
  }
  return out.join(" ");
}

// The same moves as score-sheet rows, [number, white, black], for the
// Practice side panel's numbered two-column list (Lichess's bot games).
export function playTrailRows(history, startFen = START_FEN) {
  const parts = String(startFen || START_FEN).trim().split(/\s+/);
  let full = Number(parts[5]) || 1;
  let side = parts[1] === "b" ? "b" : "w";
  const rows = [];
  for (const ply of Array.isArray(history) ? history : []) {
    if (!ply?.san) continue;
    if (side === "w") rows.push([full, ply.san, ""]);
    else if (rows.length) rows[rows.length - 1][2] = ply.san;
    else rows.push([full, "", ply.san]);
    if (side === "b") full += 1;
    side = side === "w" ? "b" : "w";
  }
  return rows;
}

// Undo back to the user's previous decision: drop a trailing opponent ply,
// then drop the user ply that led there. Empty history means the session start.
export function takebackToUserMove(history) {
  const list = Array.isArray(history) ? history.slice() : [];
  if (!list.length) {
    return { history: [], fen: null, nodeId: null, repertoireCursors: null, lastMove: null };
  }
  if (list[list.length - 1].by === "opp") list.pop();
  if (list.length && list[list.length - 1].by === "user") list.pop();
  const last = list[list.length - 1] || null;
  return {
    history: list,
    fen: last ? last.fenAfter : null,
    nodeId: last ? last.nodeIdAfter : null,
    repertoireCursors: last && last.repertoireCursorsAfter ? last.repertoireCursorsAfter : null,
    lastMove: last ? last.uci : null,
  };
}

export function playBookName(book) {
  return book === "repertoire" ? "My repertoire" : book === "maia" ? "Maia" : "Lichess explorer";
}

export function playSessionPgn(play, playerName) {
  const session = play || {};
  const startFen = session.startFen || START_FEN;
  const trail = formatPlayTrail(session.history, startFen);
  const youWhite = session.userColor !== "black";
  const book = playBookName(session.book);
  const opponent = session.rating ? `${book} ${session.rating}` : book;
  const escapeName = (name) => String(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
  const player = escapeName(String(playerName || "").trim() || "?");
  const opponentName = escapeName(opponent);
  const result = session.result || "*";
  const headers = [
    `[Event "Practice game"]`,
    `[White "${youWhite ? player : opponentName}"]`,
    `[Black "${youWhite ? opponentName : player}"]`,
    `[Result "${result}"]`,
  ];
  const placement = String(startFen).trim().split(/\s+/)[0];
  if (placement && placement !== START_FEN.split(" ")[0]) {
    headers.push(`[FEN "${startFen}"]`, `[SetUp "1"]`);
  }
  return `${headers.join("\n")}\n\n${trail ? `${trail} ` : ""}${result}`;
}

// A Practice game with moves on the board is gone once it is left: nothing
// resumes it, unlike a queue or rehearsal session the server picks back up.
export function playGameInProgress(play) {
  return !!(play && play.active && (play.history || []).length);
}

// Leaving a game in progress asks first. Resolves true to go ahead.
export function confirmAbandonGame(play, showConfirmModal, title, okLabel) {
  if (!playGameInProgress(play)) return Promise.resolve(true);
  return showConfirmModal({ title, body: "The current game will be abandoned.", okLabel, cancelLabel: "Keep playing" });
}
