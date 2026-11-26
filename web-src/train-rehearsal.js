import { planTrainRunIn, playTrainRunIn } from "./train-flow.js";

const key = (owner, rep) => `pf.rehearsal.${encodeURIComponent(owner)}.${encodeURIComponent(rep)}`;

export function loadRehearsal(owner, rep) {
  try {
    const memo = JSON.parse(localStorage.getItem(key(owner, rep)) || "null");
    return memo?.training?.prompt && Array.isArray(memo.stats?.history) ? memo : null;
  } catch { return null; }
}

export function saveRehearsal(owner, training, stats, attempt) {
  if (!owner || !training?.repertoire_id) return;
  try {
    const name = key(owner, training.repertoire_id);
    if (training.prompt) localStorage.setItem(name, JSON.stringify({ training, stats, attempt }));
    else localStorage.removeItem(name);
  } catch { /* best effort */ }
}

export function restoreRehearsal(owner, training) {
  const memo = loadRehearsal(owner, training.repertoire_id);
  const sameRun = memo?.training.session_id === training.session_id &&
    Array.isArray(training.line_order) &&
    JSON.stringify(memo.training.line_order) === JSON.stringify(training.line_order) &&
    memo.training.prompt.current_index <= training.prompt.current_index;
  if (!sameRun) return null;
  const samePrompt = ["current_index", "line_node_id", "fen_before"].every(name =>
    memo.training.prompt[name] === training.prompt[name]);
  return { stats: memo.stats, attempt: samePrompt && Number.isInteger(memo.attempt) && memo.attempt > 0 ? memo.attempt : 1 };
}

// Play the moves a rehearsal prompt already knows (from move 1 when a line
// starts, own moves asked on an earlier line included) before asking. The same
// prompt shown again after a miss or a recovery is not replayed. Returns false
// when the session moved on mid-animation.
export async function playRehearsalRunIn(board, state, prompt, { sleep, setTrainBanner }) {
  const training = state.training;
  if (!board || !training || !prompt.run_in || training.runInAt === prompt.fen_before) return true;
  const plan = planTrainRunIn(prompt, board.fen, training.runInPath || []);
  Object.assign(training, { runInPath: plan.path, runInAt: prompt.fen_before });
  if (!plan.moves.length && !plan.rewind?.length) return true;
  state.trainBusy = true;
  setTrainBanner("runin", prompt.target_index ? "Continue the line" : "Next line", plan.moves.at(-1)?.san || "");
  const played = await playTrainRunIn(board, plan, {
    active: () => state.training === training && !state.smart && training.prompt === prompt, sleep,
  });
  if (!played.stopped) state.trainBusy = false;
  return !played.stopped;
}
