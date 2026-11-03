// Client-side board utility: legal moves, status and applied moves via chess.js,
// so boards work signed out and every move click stays local.
//   localBoardInfo(fen)        → { fen, side_to_move, legal_moves, status }
//   localBoardAfterMove(fen,…) → { move, board }
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

// Premove destinations ignore check and the opponent's pending move. The real
// legal list is checked again when the opponent lands. Pawns may queue a capture
// on an empty square, since the opponent can move a piece there.
export function localPremoveMoves(fen, color) {
  const chess = new Chess(fen);
  const side = color === "black" ? "b" : "w";
  const moves = [];
  const at = (x, y) => `${"abcdefgh"[x]}${y + 1}`;
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
    const from = at(x, y);
    const piece = chess.get(from);
    if (piece?.color !== side) continue;
    for (let tx = 0; tx < 8; tx++) for (let ty = 0; ty < 8; ty++) {
      const dx = tx - x, dy = ty - y;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (!ax && !ay) continue;
      const to = at(tx, ty);
      const target = chess.get(to);
      if (target?.color === side) continue;
      let reachable = false;
      if (piece.type === "p") {
        const forward = side === "w" ? 1 : -1;
        reachable = dy === forward && (ax === 1 || !ax && !target) ||
          !ax && dy === 2 * forward && y === (side === "w" ? 1 : 6) &&
          !target && !chess.get(at(x, y + forward));
      } else if (piece.type === "n") reachable = ax * ay === 2;
      else if (piece.type === "k") {
        reachable = Math.max(ax, ay) === 1;
        const rights = fen.split(" ")[2];
        const home = side === "w" ? 0 : 7;
        if (x === 4 && y === home && ty === home && (tx === 2 || tx === 6)) {
          const right = tx === 6 ? "k" : "q";
          const rook = chess.get(at(tx === 6 ? 7 : 0, home));
          reachable = rights.includes(side === "w" ? right.toUpperCase() : right) &&
            rook?.type === "r" && rook.color === side &&
            (tx === 6 ? [5, 6] : [1, 2, 3]).every((file) => !chess.get(at(file, home)));
        }
      } else {
        reachable = piece.type !== "b" && (!ax || !ay) || piece.type !== "r" && ax === ay;
        if (reachable) for (let step = 1; step < Math.max(ax, ay); step++) {
          if (chess.get(at(x + Math.sign(dx) * step, y + Math.sign(dy) * step))) {
            reachable = false;
            break;
          }
        }
      }
      if (reachable) {
        if (piece.type === "p" && (ty === 0 || ty === 7)) {
          for (const promotion of ["q", "r", "b", "n"]) moves.push(`${from}${to}${promotion}`);
        } else moves.push(`${from}${to}`);
      }
    }
  }
  return moves;
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

// True when the side to move in `fen` is in check — the one question the move
// sound asks, without building the whole board payload. A malformed FEN (or one
// with no king) answers false rather than throwing into a caller's paint.
export function fenInCheck(fen) {
  try {
    return new Chess(fen).isCheck();
  } catch (_) {
    return false;
  }
}

// True for the standard start position with White to move (castling and clocks ignored).
export function isStartFen(fen) {
  const parts = String(fen || "").trim().split(/\s+/);
  return parts[0] === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR" && parts[1] === "w";
}

// SAN for a UCI line from fen, played on one board. Stops at the first move that
// is illegal (or a malformed FEN) and returns what it has.
export function localSanLine(fen, uciLine) {
  const san = [];
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return san;
  }
  for (const uci of uciLine || []) {
    try {
      san.push(chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci.slice(4) : undefined,
      }).san);
    } catch (_) {
      break;
    }
  }
  return san;
}

// SAN for one engine PV. `pv` is a provider line ({ pv_uci }) or a bare UCI array; a line
// that already carries SAN (a whole-game pass result, a saved analysis) is used as it is.
// Otherwise the line is replayed once and memoised on its own move array: no long-lived
// cache to trim, and a version converted for another position is converted again rather
// than reused, so a PV is never shown against the wrong FEN.
const pvSanMemo = new WeakMap();

export function pvSan(fen, pv) {
  const uci = Array.isArray(pv) ? pv : pv && pv.pv_uci;
  if (!Array.isArray(uci) || !uci.length) return [];
  const ready = !Array.isArray(pv) && pv.pv_san;
  if (ready && ready.length) return ready;
  const hit = pvSanMemo.get(uci);
  if (hit && hit.fen === fen) return hit.san;
  const san = localSanLine(fen, uci);
  pvSanMemo.set(uci, { fen, san });
  return san;
}

// Game-over state for a FEN, or null while play continues. The engine has no
// line to show in these positions (Stockfish answers `bestmove (none)`), so the
// UI reports the result instead of waiting on a search that never produces one.
//   { kind: "checkmate", winner: "white" | "black", result: "1-0" | "0-1" }
//   { kind: "stalemate" | "draw", winner: null, result: "½-½" }
export function localGameOver(fen) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return null;
  }
  if (chess.isCheckmate()) {
    const winner = chess.turn() === "w" ? "black" : "white";
    return { kind: "checkmate", winner, result: winner === "white" ? "1-0" : "0-1" };
  }
  if (chess.isStalemate()) return { kind: "stalemate", winner: null, result: "½-½" };
  if (chess.isDraw()) return { kind: "draw", winner: null, result: "½-½" };
  return null;
}
