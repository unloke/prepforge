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

export function rehearsalStats(owner, training) {
  const memo = loadRehearsal(owner, training.repertoire_id);
  return memo?.training.session_id === training.session_id &&
    memo.training.session_generation === training.session_generation ? memo.stats : null;
}
