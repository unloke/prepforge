// Pure exercise planning, hint/answer narration, PV continuation extraction,
// and session statistics for Analyze Retry.
import { Chess } from "chess.js";
import { localBoardInfo } from "./chess-local.js";
import { describeMove } from "./explain.js";

export const RETRY_ERROR_GRADES = new Set(["mistake", "blunder", "missed"]);

export const GRADE_WORD = {
  brilliant: "Brilliant", great: "Great", excellent: "Good", good: "Good",
  inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder", missed: "Missed win",
};

const PIECE_WORD = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

export function retryExercises(moments = [], ply = 0, selfSide = null) {
  return moments
    .filter((m) => m.ply > ply && (!selfSide || selfSide === m.side))
    .flatMap((m) => {
      if (m.preparedMoves?.length && m.by === "you") return [{ ...m, kind: "prep", answers: m.preparedMoves }];
      if (RETRY_ERROR_GRADES.has(m.grade) && m.best?.uci) return [{ ...m, kind: "engine", answers: [m.best] }];
      return [];
    });
}

export function retryPlan(moments = [], ply = 0, selfSide = null) {
  const ahead = retryExercises(moments, ply, selfSide);
  if (ahead.length) return { exercises: ahead, wrapped: false };
  const all = retryExercises(moments, 0, selfSide);
  return { exercises: all, wrapped: all.length > 0 };
}

export function describeRetryHint(fenBefore, uci) {
  if (!fenBefore || !uci || uci.length < 4) return "Hint · Find the strongest candidate";
  const from = uci.slice(0, 2);
  try {
    const piece = new Chess(fenBefore).get(from);
    if (!piece) return `Hint · Check ${from}`;
    if (piece.type === "k" && Math.abs(uci.charCodeAt(0) - uci.charCodeAt(2)) > 1) {
      return "Hint · Get your king to safety";
    }
    return `Hint · Move the ${PIECE_WORD[piece.type] || "piece"} on ${from}`;
  } catch {
    return `Hint · Move from ${from}`;
  }
}

export function describeRetryAnswer(fenBefore, uci, san) {
  if (!fenBefore || !uci) return "";
  try {
    const raw = describeMove(fenBefore, uci, san);
    return raw ? `${raw.charAt(0).toUpperCase()}${raw.slice(1)}.` : "";
  } catch {
    return "";
  }
}

export function continuationSteps(analysis, fenBefore, playedUci, maxPlies = 3) {
  const pv = analysis?.position_evals?.[fenBefore]?.pv;
  if (!Array.isArray(pv) || pv[0] !== playedUci || pv.length < 2) return [];
  try {
    const chess = new Chess(fenBefore);
    const first = chess.move({ from: playedUci.slice(0, 2), to: playedUci.slice(2, 4), promotion: playedUci[4] });
    if (!first) return [];
    const steps = [{ uci: playedUci, san: first.san, fen: chess.fen(), label: first.san }];
    for (const uci of pv.slice(1, 1 + maxPlies)) {
      const fields = chess.fen().split(" ");
      const num = Number(fields[5]) || 1;
      const black = fields[1] === "b";
      const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      if (!mv) break;
      const label = black ? (steps.length > 1 ? mv.san : `${num}…${mv.san}`) : `${num}.${mv.san}`;
      steps.push({ uci, san: mv.san, fen: chess.fen(), label });
    }
    return steps.length > 1 ? steps : [];
  } catch {
    return [];
  }
}

export function prevMoveInfo(analysis, ply) {
  const prev = ply > 1 && Array.isArray(analysis?.moves)
    ? analysis.moves.find((m) => Number(m.ply) === ply - 1)
    : null;
  if (!prev?.san) return { label: "", uci: null };
  const black = prev.side === "black" || (!prev.side && (ply - 1) % 2 === 0);
  const num = prev.move_number ?? Math.ceil((ply - 1) / 2);
  return { label: `${num}${black ? "…" : "."}${prev.san}`, uci: prev.uci || null };
}

export function promptSub(analysis, item) {
  const { label } = prevMoveInfo(analysis, item.ply);
  const after = label ? `After ${label} · ` : "";
  if (item.kind === "prep") return `${after}played ${item.label}${item.repName ? ` · left ${item.repName}` : ""}`;
  const word = GRADE_WORD[item.grade] || "Mistake";
  return `${after}played ${item.label} (${word}${item.loss ? `, −${item.loss}%` : ""})`;
}

export function wrongGradeDetail(san, grade) {
  const word = GRADE_WORD[grade];
  if (grade === "good" || grade === "excellent") return `${san} is playable, but a stronger move is available`;
  if (word) return `${san} is ${/^[aeiou]/i.test(word) ? "an" : "a"} ${word.toLowerCase()}`;
  return `Played ${san}`;
}

export function legalMovesAt(fen) {
  try { return localBoardInfo(fen).legal_moves || []; } catch { return []; }
}

export function retryStats(session) {
  const total = session.sequence.length;
  let clean = 0, recovered = 0, missed = 0;
  for (const o of session.outcomes) {
    if (o === "clean") clean += 1;
    else if (o === "recovered") recovered += 1;
    else if (o === "missed") missed += 1;
  }
  const retryable = session.sequence.filter((_, i) => session.outcomes[i] !== "clean");
  const isPrep = (item) => item.kind === "prep" && item.repId && item.prescribedNodeId;
  const prepTarget = session.sequence.find((it, i) => isPrep(it) && session.outcomes[i] !== "clean")
    || session.sequence.find(isPrep) || null;
  return { total, clean, recovered, missed, retryable, prepTarget };
}
