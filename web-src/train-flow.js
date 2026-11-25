import { prefersReducedMotion } from "./board/move-motion.js";

// Keep the shared opening context when moving between sibling lines. Every
// run-in position comes from the start bundle, so replay needs no API calls.
export function planTrainRunIn(prompt, currentFen, previousPath = []) {
  const moves = prompt.run_in || [];
  const newLine = prompt.target_index === 0;
  const path = newLine ? moves : [...previousPath, ...moves];
  if (currentFen === prompt.fen_before) return { startFen: currentFen, moves: [], path };
  const onPath = path.findLastIndex((move) => move.fen_after === currentFen);
  if (onPath >= 0) return { startFen: currentFen, moves: path.slice(onPath + 1), path };
  let common = 0;
  let rewind = [];
  if (newLine) {
    while (common < moves.length && common < previousPath.length
      && moves[common].uci === previousPath[common].uci
      && moves[common].fen_after === previousPath[common].fen_after) common++;
    const currentIndex = previousPath.findLastIndex((move) => move.fen_after === currentFen);
    if (common && currentIndex >= 0) {
      for (let index = currentIndex - 1; index >= common - 1; index--) {
        if (index >= 0) rewind.push(previousPath[index]);
      }
    }
  }
  return {
    startFen: common ? moves[common - 1].fen_after : prompt.start_fen,
    moves: moves.slice(common), path, rewind,
  };
}

const RUN_IN_STEP_MS = 220;
const RUN_IN_BUDGET_MS = 880;
const REWIND_STEP_MS = 90;
const REWIND_BUDGET_MS = 360;
const stepMs = (count, step, budget) => (count ? Math.min(step, budget / count) : step);

// Play a planned line transition. Rewinds are quiet and quicker than the
// teaching replay; long lines compress their cadence so the whole transition
// stays inside one budget instead of growing move by move.
export async function playTrainRunIn(board, plan, { active, sleep }) {
  let cueUci = null;
  if (prefersReducedMotion()) {
    if (!active()) return { stopped: true, cueUci };
    const finalMove = plan.moves[plan.moves.length - 1];
    cueUci = finalMove?.uci || null;
    board.setPosition({
      fen: finalMove?.fen_after || plan.startFen,
      legalMoves: [],
      lastMove: cueUci,
    });
    return { stopped: false, cueUci };
  }
  const rewind = plan.rewind || [];
  const rewindMs = stepMs(rewind.length, REWIND_STEP_MS, REWIND_BUDGET_MS);
  const moveMs = stepMs(plan.moves.length, RUN_IN_STEP_MS, RUN_IN_BUDGET_MS);
  if (!rewind.length) board.setPosition({ fen: plan.startFen, legalMoves: [], lastMove: null });
  for (const mv of rewind) {
    if (!active()) return { stopped: true, cueUci };
    board.setPosition({ fen: mv.fen_after, legalMoves: [], lastMove: null, back: true });
    await sleep(rewindMs);
  }
  for (const mv of plan.moves) {
    if (!active()) return { stopped: true, cueUci };
    board.setPosition({ fen: mv.fen_after, legalMoves: [], lastMove: mv.uci });
    cueUci = mv.uci;
    await sleep(moveMs);
  }
  return { stopped: false, cueUci };
}
