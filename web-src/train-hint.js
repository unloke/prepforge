import { describeMove } from "./explain.js";

// Sub-line under "Not your prep · try again" after a first miss in the Smart
// queue. A hint the user already asked for must survive the miss: falling back
// to a generic phase tip ("Develop your pieces…") after "Hint 2 · Piece" took
// the help away exactly when it was needed (UX walkthrough 2026-10-01 P1-4).
export function wrongMoveTip({ hintLevel = 0, hint = {}, expectedSan = "", coachTip = "" } = {}) {
  const level = Number(hintLevel) || 0;
  const strategy = hint && hint.strategy;
  const piece = hint && hint.piece;
  if (level >= 3 && expectedSan) return `Play ${expectedSan}`;
  if (level >= 2 && piece) return piece;
  if (level >= 1 && strategy) return strategy;
  return coachTip || strategy || piece || "";
}

// The Maia coach tip arrives asynchronously; it may only replace the line when
// the user has not asked for a more specific hint meanwhile.
export function coachTipMayReplace(hintLevel) {
  return !(Number(hintLevel) > 0);
}

// "Why this move", engine-free, for the moments the answer is on screen (teach
// cards and the second-miss reveal). The repertoire author's own annotation wins;
// otherwise describe what the move actually does on the board (chess.js only, so
// Train keeps needing no engine); the server's generic heuristic is the last resort.
export function teachWhy(prompt, fallback) {
  const hint = (prompt && prompt.hint) || {};
  if (hint.annotated && hint.strategy) return hint.strategy;
  const did = describeMove(prompt.fen_before, prompt.expected_uci, prompt.expected_san);
  if (did) return `${did.charAt(0).toUpperCase()}${did.slice(1)}.`;
  return hint.strategy || fallback;
}

// Teach/reveal explanation: the move's own description (teachWhy) plus the phase
// coach's note only when that note is specific to the position (model.generic marks
// the canned phase advice, which is dropped instead of repeated on every card).
export function trainTeachLine(prompt, model) {
  const parts = [teachWhy(prompt, "")];
  if (model && model.tip && !model.generic) parts.push(model.tip);
  return parts.filter(Boolean).join(" ");
}

// The opponent move a card answers ("answer 3...Nf6"), from the run-in or the
// previous step of the same card. "" when the card starts from the initial position.
export function promptCueSan(smart, prompt) {
  const runIn = prompt.run_in || [];
  let san = runIn.length ? runIn[runIn.length - 1].san : "";
  if (!san) {
    const card = smart.queue[smart.cardIndex];
    const prev = card && smart.targetIndex > 0 ? card.targets[smart.targetIndex - 1] : null;
    san = prev && prev.reply ? prev.reply.san : "";
  }
  if (!san) return "";
  const parts = String(prompt.fen_before || "").split(" ");
  const num = Number(parts[5]) || 1;
  // The cue was played by the other side: number it from the prompt's position.
  return parts[1] === "w" ? `${num - 1}...${san}` : `${num}.${san}`;
}
