// Trial history is local to this browser and scoped to the signed-in owner.
// One completed Smart/Blitz run per session generation; retries never add a row.
const PREFIX = 'pf.trainHistory:';
const prefixFor = ownerId => `${PREFIX}${encodeURIComponent(ownerId)}:`;
function browserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function saveSmartRun(ownerId, smart, stats, storage = browserStorage(), now = new Date()) {
  if (!ownerId || !storage || !smart?.sessionId || !smart.generation || !smart.queue?.length ||
      !Number.isInteger(smart.cardIndex) || smart.cardIndex < smart.queue.length ||
      !Number.isInteger(smart.cardsDone) || smart.cardsDone < 0) return false;
  const counters = ['correct', 'mistakes', 'skipped'];
  if (!counters.every(key => Number.isInteger(stats?.[key]) && stats[key] >= 0)) return false;
  const id = `${smart.sessionId}:${smart.generation}`;
  const key = prefixFor(ownerId) + encodeURIComponent(id);
  const repertoires = [...new Set(smart.queue.map(card => card.repertoire_name).filter(Boolean))];
  if (!repertoires.length && smart.repertoireName) repertoires.push(smart.repertoireName);
  const run = { id, mode: smart.blitz ? 'blitz' : 'smart', repertoires,
    startedAt: smart.generation, finishedAt: now.toISOString(),
    cards: smart.cardsDone, correct: stats.correct, mistakes: stats.mistakes, skipped: stats.skipped };
  try {
    if (!storage.getItem(key)) storage.setItem(key, JSON.stringify(run));
    return true;
  } catch { return false; }
}

export function readTrainingHistory(ownerId, storage = browserStorage()) {
  if (!ownerId) return [];
  if (!storage) throw new Error('Allow site storage to save and view history.');
  const prefix = prefixFor(ownerId), runs = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) runs.push(JSON.parse(storage.getItem(key)));
  }
  return runs.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.id.localeCompare(b.id));
}
