// Smart-queue session memo: the first-try stats and the health snapshot taken
// when the session STARTED. The server resumes a session at its card index, but
// these lived only in memory, so a reload mid-session dropped earlier answers
// ("4 cards · 100% first try" beside "3 first-try correct") and re-based the
// summary deltas on the resume-time health.
//
// Scope by owner and session; another account or tab cannot replace this memo.

const KEY = "pf.trainSessionMemo";

function key(ownerId, sessionId, generation = "") {
  return `${KEY}.${encodeURIComponent(ownerId)}.${encodeURIComponent(sessionId)}.${encodeURIComponent(generation)}`;
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

export function saveSessionMemo(ownerId, sessionId, memo, storage = defaultStorage()) {
  if (!storage || !ownerId || !sessionId) return false;
  try {
    storage.setItem(key(ownerId, sessionId, memo.generation), JSON.stringify({ ...memo, sessionId: String(sessionId) }));
    return true;
  } catch (_) {
    return false;
  }
}

export function loadSessionMemo(ownerId, sessionId, generation = "", storage = defaultStorage()) {
  if (!storage || !ownerId || !sessionId) return null;
  try {
    const memo = JSON.parse(storage.getItem(key(ownerId, sessionId, generation)) || "null");
    if (!memo || memo.sessionId !== String(sessionId)) return null;
    const stats = memo.stats;
    if (!stats || !Array.isArray(stats.history)) return null;
    if (!["correct", "mistakes", "streak", "best", "lastStreak"].every((name) =>
      Number.isInteger(stats[name]) && stats[name] >= 0)) return null;
    if (!stats.history.every((value) => typeof value === "boolean")) return null;
    if (!Array.isArray(memo.queue) || !memo.queue.length || memo.queue.some((card) =>
      !card?.encoded || !Array.isArray(card.targets) || !card.targets.length)) return null;
    if (!["cardIndex", "targetIndex", "cardsDone", "retriesFixed", "timeouts"].every((name) =>
      Number.isInteger(memo[name]) && memo[name] >= 0)) return null;
    if (!Number.isInteger(memo.attempt) || memo.attempt < 1) return null;
    if (memo.cardIndex > memo.queue.length) return null;
    if (memo.cardIndex < memo.queue.length && memo.targetIndex >= memo.queue[memo.cardIndex].targets.length) return null;
    return memo;
  } catch (_) {
    return null;
  }
}

export function clearSessionMemo(ownerId, sessionId, generation = "", storage = defaultStorage()) {
  if (!storage || !ownerId || !sessionId) return;
  try {
    storage.removeItem(key(ownerId, sessionId, generation));
  } catch (_) {
    /* best-effort */
  }
}

export function restoreSmartSession(ownerId, mapped, smart) {
  const memo = mapped.resumed ? loadSessionMemo(ownerId, mapped.sessionId, mapped.generation) : null;
  if (!memo || memo.generation !== mapped.generation || memo.seed !== mapped.seed || memo.cardIndex < mapped.cardIndex ||
      !mapped.queue.every((card) => memo.queue.some((saved) => saved.encoded === card.encoded))) return null;
  // Restore order/requeues, but use the server's current FENs, hints and replies.
  const cards = new Map(mapped.queue.map((card) => [card.encoded, card]));
  if (memo.queue.some((card) => !cards.has(card.encoded))) return null;
  const queue = memo.queue.map((card) => cards.get(card.encoded));
  if (memo.cardIndex < queue.length && memo.targetIndex >= queue[memo.cardIndex].targets.length) return null;
  Object.assign(smart, {
    queue, cardIndex: memo.cardIndex, targetIndex: memo.targetIndex,
    cardsDone: memo.cardsDone, retriesFixed: memo.retriesFixed, timeouts: memo.timeouts,
    attempt: memo.attempt, totalCards: queue.length,
  });
  smart.counts = {};
  for (const card of queue) smart.counts[card.kind] = (smart.counts[card.kind] || 0) + 1;
  if (memo.healthBefore) smart.healthBefore = memo.healthBefore;
  return { ...memo.stats, history: [...memo.stats.history] };
}

export function saveSmartSession(ownerId, smart, stats, { advance = false, ...progress } = {}) {
  const withinCard = smart.targetIndex + 1 < smart.queue[smart.cardIndex]?.targets.length;
  if (advance) progress = {
    cardIndex: smart.cardIndex + (withinCard ? 0 : 1),
    targetIndex: withinCard ? smart.targetIndex + 1 : 0,
    cardsDone: smart.cardsDone + (withinCard ? 0 : 1), attempt: 1,
  };
  return saveSessionMemo(ownerId, smart.sessionId, {
    generation: smart.generation, seed: smart.seed,
    stats, healthBefore: smart.healthBefore || null, retriesFixed: smart.retriesFixed || 0,
    queue: smart.queue, cardIndex: smart.cardIndex, targetIndex: smart.targetIndex,
    cardsDone: smart.cardsDone, attempt: smart.attempt, timeouts: smart.timeouts || 0,
    ...progress,
  });
}
