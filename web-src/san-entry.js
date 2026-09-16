// Typed SAN entry for Analyze / Build / Train boards.
// Pure: given a FEN + keystrokes, either play a legal SAN, keep a prefix
// buffer, reject an illegal token, or clear. DOM/I/O stays in the caller.

import { Chess } from "chess.js";

function uciOf(move) {
  return move.lan || move.from + move.to + (move.promotion || "");
}

function stripMarks(san) {
  return String(san || "").replace(/[+#?!]/g, "");
}

const SAN_CHAR = /^[a-hKQRBNOx\-+=0-8]$/;

export function isSanChar(key) {
  if (!key || key.length !== 1) return false;
  return SAN_CHAR.test(key);
}

function matchesExact(move, text, stripped) {
  return move.san === text || stripMarks(move.san) === stripped;
}

function isLongerPrefix(move, text, stripped) {
  // Check/mate suffixes (+/#) are the same move, not a longer alternative.
  // O-O vs O-O-O are different moves; only the latter counts as a longer prefix.
  if (matchesExact(move, text, stripped)) return false;
  const marksOff = stripMarks(move.san);
  return marksOff.startsWith(stripped) && marksOff.length > stripped.length;
}

/**
 * Match typed SAN against legal moves of `fen`.
 * - play: exactly one legal move matches, and (unless `commit`) the typed
 *   text is not also a prefix of a longer legal SAN. So "O-O" stays a
 *   prefix while "O-O-O" is still legal; Enter sets `commit` to take the
 *   unique exact match anyway.
 * - prefix: typed text is a prefix of at least one legal SAN
 * - illegal: cannot become a legal SAN from this position
 */
export function resolveSan(fen, typed, { commit = false } = {}) {
  const text = String(typed || "").trim();
  if (!text) return { status: "prefix", uci: null, san: "" };
  let chess;
  try {
    chess = new Chess(fen);
  } catch {
    return { status: "illegal", uci: null, san: text };
  }
  const legal = chess.moves({ verbose: true });
  const stripped = stripMarks(text);
  const exact = legal.filter((move) => matchesExact(move, text, stripped));
  const longer = legal.filter((move) => isLongerPrefix(move, text, stripped));
  if (exact.length === 1 && (commit || longer.length === 0)) {
    return { status: "play", uci: uciOf(exact[0]), san: exact[0].san };
  }
  if (exact.length > 0 || longer.length > 0) {
    return { status: "prefix", uci: null, san: text };
  }
  const prefix = legal.filter((move) => {
    const san = move.san;
    return san.startsWith(text) || stripMarks(san).startsWith(stripped);
  });
  if (prefix.length > 0) return { status: "prefix", uci: null, san: text };
  return { status: "illegal", uci: null, san: text };
}

/**
 * Apply one keyboard event to a SAN buffer.
 * Returns { action, buffer, uci, san } where action is
 * play | reject | buffer | clear | ignore.
 */
export function applySanKey(buffer, key, fen) {
  const current = String(buffer || "");
  if (key === "Escape") {
    if (!current) return { action: "ignore", buffer: "", uci: null, san: "" };
    return { action: "clear", buffer: "", uci: null, san: "" };
  }
  if (key === "Backspace") {
    const next = current.slice(0, -1);
    return { action: next ? "buffer" : "clear", buffer: next, uci: null, san: next };
  }
  if (key === "Enter") {
    if (!current) return { action: "ignore", buffer: current, uci: null, san: "" };
    const resolved = resolveSan(fen, current, { commit: true });
    if (resolved.status === "play") {
      return { action: "play", buffer: "", uci: resolved.uci, san: resolved.san };
    }
    return { action: "reject", buffer: "", uci: null, san: current };
  }
  if (!isSanChar(key)) {
    return { action: "ignore", buffer: current, uci: null, san: current };
  }
  const next = current + key;
  const resolved = resolveSan(fen, next);
  if (resolved.status === "play") {
    return { action: "play", buffer: "", uci: resolved.uci, san: resolved.san };
  }
  if (resolved.status === "prefix") {
    return { action: "buffer", buffer: next, uci: null, san: next };
  }
  return { action: "reject", buffer: "", uci: null, san: next };
}

export function createSanBuffer() {
  let text = "";
  return {
    get text() {
      return text;
    },
    clear() {
      text = "";
      return text;
    },
    handleKey(key, fen) {
      const result = applySanKey(text, key, fen);
      if (result.action === "ignore") return result;
      text = result.buffer;
      return result;
    },
  };
}
