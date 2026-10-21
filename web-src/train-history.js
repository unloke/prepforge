// Completed Smart queue / Blitz runs, kept in this browser and scoped to the
// signed-in owner. One JSON document per account, newest first, bounded to
// 100 runs and 96 KiB of serialized UTF-8 JSON. Older runs fall off; a run is
// never dropped for its own long repertoire names (the newest one is kept even
// if it alone exceeds the byte budget). One record per session generation, so a
// retry or a re-render after completion adds nothing. Storage failures return
// false and never throw into training completion.

const PREFIX = 'pf.trainHistory:';

export const HISTORY_LIMITS = {
  runs: 100,
  // Bytes of the serialized document for one account ("{v,runs}" JSON), counted
  // as UTF-8, not the browser's internal UTF-16 units.
  bytes: 96 * 1024,
};

const encoder = new TextEncoder();
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

function readRuns(ownerId, storage) {
  const raw = storage.getItem(keyFor(ownerId));
  if (!raw) return [];
  let doc;
  try { doc = JSON.parse(raw); } catch { return []; }
  return doc?.v === 1 && Array.isArray(doc.runs)
    ? doc.runs.filter(isRun).slice(0, HISTORY_LIMITS.runs)
    : [];
}

// Newest first, count-capped, then byte-capped from the oldest end. The newest
// record is always kept: a single oversized record beats losing the run the
// user just finished. Sizes are summed per record (an array's JSON is the join
// of its records), so the check stays linear.
const DOC_BYTES = encoder.encode('{"v":1,"runs":[]}').length;
function bounded(runs) {
  const kept = runs.slice(0, HISTORY_LIMITS.runs);
  const sizes = kept.map(run => encoder.encode(JSON.stringify(run)).length);
  let bytes = DOC_BYTES + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, kept.length - 1);
  while (kept.length > 1 && bytes > HISTORY_LIMITS.bytes) {
    bytes -= sizes.pop() + 1;
    kept.pop();
  }
  return kept;
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
    cards: smart.cardsDone, correct: stats.correct, mistakes: stats.mistakes, skipped: stats.skipped,
  };
  try {
    const previous = readRuns(ownerId, storage);
    // The same generation was already recorded: keep that record's values.
    if (previous.some(existing => existing.id === id)) return true;
    storage.setItem(keyFor(ownerId), JSON.stringify({ v: 1, runs: bounded([run, ...previous]) }));
    return true;
  } catch { return false; }
}

export function readTrainingHistory(ownerId, storage = browserStorage()) {
  if (!ownerId) return [];
  if (!storage) throw new Error('Allow site storage to save and view history.');
  return readRuns(ownerId, storage).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.id.localeCompare(b.id));
}

// What this account currently keeps, for the History footer. Bytes are the
// serialized document's UTF-8 length, the same measure the save path enforces.
export function trainingHistoryUsage(ownerId, storage = browserStorage()) {
  if (!ownerId || !storage) return { runs: 0, bytes: 0 };
  const raw = storage.getItem(keyFor(ownerId));
  return { runs: readRuns(ownerId, storage).length, bytes: raw ? encoder.encode(raw).length : 0 };
}
