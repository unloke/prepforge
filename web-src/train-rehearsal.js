const key = (owner, rep) => `pf.rehearsal.${encodeURIComponent(owner)}.${encodeURIComponent(rep)}`;

export function loadRehearsal(owner, rep) {
  try {
    const memo = JSON.parse(localStorage.getItem(key(owner, rep)) || "null");
    return memo?.training?.prompt && Array.isArray(memo.stats?.history) ? memo : null;
  } catch (_) { return null; }
}

export function saveRehearsal(owner, training, stats, attempt) {
  if (!owner || !training?.repertoire_id) return;
  try {
    const name = key(owner, training.repertoire_id);
    if (training.prompt) localStorage.setItem(name, JSON.stringify({ training, stats, attempt }));
    else localStorage.removeItem(name);
  } catch (_) { /* best effort */ }
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
