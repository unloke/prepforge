// Completed Smart queue / Blitz runs, kept in this browser and scoped to the
// signed-in owner. One JSON document per account, newest first by finish time,
// with two hard bounds: 100 runs and 96 KiB of the serialized document
// (wrapper and separators included). A run that does not fit is not saved and
// the document already on disk is left exactly as it was; training completion
// carries on either way. One record per session generation, so a retry or a
// re-render after completion adds nothing. Storage failures return false and
// never throw into training completion.

const PREFIX = 'pf.trainHistory:';

export const HISTORY_LIMITS = {
  runs: 100,
  // UTF-8 bytes of the whole serialized value for one account: the JSON string
  // stored under the key, not the browser's internal UTF-16 accounting.
  bytes: 96 * 1024,
};

const encoder = new TextEncoder();
const utf8 = text => encoder.encode(text).length;
// `{"v":1,"runs":[]}`: the wrapper every document carries before any record.
const DOC_BYTES = utf8('{"v":1,"runs":[]}');
const serialize = runs => JSON.stringify({ v: 1, runs });
const keyFor = ownerId => `${PREFIX}${encodeURIComponent(ownerId)}`;
const isCount = value => Number.isInteger(value) && value >= 0;

function browserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function isRun(run) {
  return !!run && typeof run.id === 'string' && run.id.length > 0 &&
    (run.mode === 'smart' || run.mode === 'blitz') &&
    Array.isArray(run.repertoires) && run.repertoires.every(name => typeof name === 'string') &&
    typeof run.finishedAt === 'string' && Number.isFinite(Date.parse(run.finishedAt)) &&
    [run.cards, run.correct, run.mistakes, run.skipped].every(isCount);
}

// Newest first by the run's own finish time: a clock that stepped backwards
// between two completions must not decide which end of the list is the old one.
const newestFirst = (a, b) =>
  Date.parse(b.finishedAt) - Date.parse(a.finishedAt) || a.id.localeCompare(b.id);

// One order and one cut, used on the way in and on the way out: sort by
// finishedAt, keep the newest `runs`, then drop from the oldest end until the
// serialized value fits `bytes`. Record sizes are summed (an array's JSON is
// the join of its records), so the check stays linear and the count matches
// `utf8(serialize(kept))` exactly: one wrapper, one comma between records.
function bounded(runs) {
  const kept = runs.slice().sort(newestFirst).slice(0, HISTORY_LIMITS.runs);
  const sizes = kept.map(run => utf8(JSON.stringify(run)));
  let bytes = DOC_BYTES + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, kept.length - 1);
  while (kept.length && bytes > HISTORY_LIMITS.bytes) {
    bytes -= sizes.pop() + (kept.length > 1 ? 1 : 0);
    kept.pop();
  }
  return kept;
}

function readRuns(ownerId, storage) {
  const raw = storage.getItem(keyFor(ownerId));
  if (!raw) return [];
  // Over the byte bound: no write of ours can produce this document, and
  // parsing it would hand back a list the bound forbids.
  if (utf8(raw) > HISTORY_LIMITS.bytes) return [];
  let doc;
  try { doc = JSON.parse(raw); } catch { return []; }
  return doc?.v === 1 && Array.isArray(doc.runs) ? bounded(doc.runs.filter(isRun)) : [];
}

export function saveSmartRun(ownerId, smart, stats, storage = browserStorage(), now = new Date()) {
  if (!ownerId || !storage || !smart?.sessionId || !smart.generation || !smart.queue?.length ||
      !Number.isInteger(smart.cardIndex) || smart.cardIndex < smart.queue.length ||
      !Number.isInteger(smart.cardsDone) || smart.cardsDone < 0) return false;
  if (!['correct', 'mistakes', 'skipped'].every(key => isCount(stats?.[key]))) return false;
  const id = `${smart.sessionId}:${smart.generation}`;
  const repertoires = [...new Set(smart.queue.map(card => card.repertoire_name).filter(Boolean))];
  if (!repertoires.length && smart.repertoireName) repertoires.push(smart.repertoireName);
  const run = {
    id, mode: smart.blitz ? 'blitz' : 'smart', repertoires,
    startedAt: smart.generation, finishedAt: now.toISOString(),
    cards: smart.cardsDone, correct: stats.correct, mistakes: stats.mistakes, skipped: stats.skipped, learned: stats.learned || 0,
  };
  try {
    const previous = readRuns(ownerId, storage);
    // The same generation was already recorded: keep that record's values.
    if (previous.some(existing => existing.id === id)) return true;
    const kept = bounded([run, ...previous]);
    // Neither bound is negotiable and the stored document is the user's
    // history: a run that does not fit is reported, not forced in over it.
    if (!kept.some(saved => saved.id === id)) return false;
    storage.setItem(keyFor(ownerId), serialize(kept));
    return true;
  } catch { return false; }
}

export function readTrainingHistory(ownerId, storage = browserStorage()) {
  if (!ownerId) return [];
  if (!storage) throw new Error('Allow site storage to save and view history.');
  return readRuns(ownerId, storage);
}
