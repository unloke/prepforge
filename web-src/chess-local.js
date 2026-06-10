// Client-side chess utility — the browser-native replacement for the server's
// /api/board and /api/board/move helpers. The Analyze/Build/Train boards used to
// round-trip every legal-move query and every applied move to the Python server,
// which (a) 401'd for signed-out visitors — so their boards rendered empty — and
// (b) added a network hop to every "next"/move click, which read as lag. chess.js
// is already bundled (engine workers import it), so the same logic runs locally
// with zero latency and no auth requirement.
//
// The two exports mirror the exact JSON shapes the old endpoints returned, so the
// app.js callers are a drop-in swap:
//   localBoardInfo(fen)        ≅ GET  /api/board
//   localBoardAfterMove(fen,…) ≅ POST /api/board/move
import { Chess } from "chess.js";

function uciOf(move) {
  // chess.js verbose moves expose `lan` (e.g. "e2e4", "e7e8q") which is exactly
  // UCI; fall back to from+to+promotion for safety.
  return move.lan || move.from + move.to + (move.promotion || "");
}

function sideWord(chess) {
  return chess.turn() === "w" ? "white" : "black";
}

// Legal moves + check/mate/stalemate status for a FEN. Shape matches the server's
// _board_payload(). Throws on a malformed FEN (chess.js raises) — callers already
// guard board calls in try/catch.
export function localBoardInfo(fen) {
  const chess = new Chess(fen);
  return {
    fen: chess.fen(),
    side_to_move: sideWord(chess),
    legal_moves: chess.moves({ verbose: true }).map(uciOf),
    status: {
      is_check: chess.isCheck(),
      is_checkmate: chess.isCheckmate(),
      is_stalemate: chess.isStalemate(),
    },
  };
}

// Apply one UCI move to a FEN and echo the resulting move + board. Shape matches
// the server's board_move(). chess.js throws on an illegal move, which the
// callers translate into a status message — same behaviour as the old 400.
export function localBoardAfterMove(fen, moveUci) {
  const chess = new Chess(fen);
  const fenBefore = chess.fen();
  const move = chess.move({
    from: moveUci.slice(0, 2),
    to: moveUci.slice(2, 4),
    promotion: moveUci.length > 4 ? moveUci.slice(4) : undefined,
  });
  const fenAfter = chess.fen();
  return {
    move: {
      uci: uciOf(move),
      san: move.san,
      fen_before: fenBefore,
      fen_after: fenAfter,
      side_to_move: sideWord(chess),
    },
    board: localBoardInfo(fenAfter),
  };
}
