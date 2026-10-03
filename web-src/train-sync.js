// Pure core of the local-first Train sync flush (app.js wires state/timers).
//
// Each graded attempt carries a stable UUID. The server stores a receipt in the
// same transaction as progress, so an uncertain response can be retried safely.
//
// Error policy (every attempt must reach an explicit outcome):
// - Network errors and 5xx stop the flush and return the failing group plus
//   everything not yet sent as `failedGroups` (retriable) — the caller requeues
//   exactly those, UUIDs intact.
// - Auth/CSRF/locked/rate-limit errors (401/403/408/423/425/429) are
//   ALSO retriable: the attempt was never acknowledged, so it must stay in the
//   queue until the server confirms it (e.g. after signing in again).
// - Only permanently-rejected groups (e.g. 404/410 when the session's
//   repertoire is gone, or a malformed payload) are dropped — and they are
//   returned as `rejectedGroups` so the caller can report them instead of
//   pretending the attempts were saved.
// - 409 means an attempt UUID was reused with different data. Replaying that
//   payload cannot reconcile it; retain it in rejectedGroups for review.
import { classifySyncError } from "./sync-errors.js";

/**
 * Group flat pending attempts by session, preserving play order within each
 * group. The current session always gets a group — even an empty one — so a
 * flush with only a dirty position still carries it.
 *
 * @param {Array<{session_id: string, node_id: string, correct: boolean, attempt_uuid: string}>} pending
 * @param {string|null} currentSessionId
 * @returns {Array<[string, Array<{node_id: string, correct: boolean, attempt_uuid: string}>]>}
 */
export function groupAttempts(pending, currentSessionId, currentGeneration) {
  const bySession = new Map();
  const key = (id, generation) => JSON.stringify([id, generation ?? null]);
  for (const item of pending) {
    const k = key(item.session_id, item.session_generation);
    if (!bySession.has(k)) bySession.set(k, [item.session_id, []]);
    bySession.get(k)[1].push({ node_id: item.node_id, correct: item.correct, attempt_uuid: item.attempt_uuid,
      ...(item.session_generation != null ? { session_generation: item.session_generation } : {}) });
  }
  const currentKey = key(currentSessionId, currentGeneration);
  if (currentSessionId && !bySession.has(currentKey)) bySession.set(currentKey, [currentSessionId, []]);
  return [...bySession.values()];
}

/**
 * Whether a failed POST may succeed later. Anything without a status (network
 * error), any 5xx, and the transient 4xx classes (auth, CSRF, conflict, rate
 * limit) are retriable. Everything else (400/404/410/422, …) is permanent for
 * this payload: retrying can never land it.
 *
 * @param {{status?: number}|null|undefined} error
 * @returns {boolean}
 */
export function isRetriableSyncError(error) {
  return classifySyncError(error).retriable;
}

/**
 * POST each group in order via `postGroup(sessionId, attempts)`.
 *
 * - success: move on.
 * - retriable error (network / 5xx / transient 4xx): stop; the failing group
 *   and all unsent groups come back as `failedGroups` with `retriable: true`.
 * - permanent 4xx: that group is dropped (nothing to retry into) but reported
 *   in `rejectedGroups`, and the flush continues with later groups.
 *
 * @param {Array<[string, Array<{node_id: string, correct: boolean, attempt_uuid: string}>]>} groups
 * @param {(sessionId: string, attempts: Array<object>) => Promise<void>} postGroup
 * @returns {Promise<{
 *   retriable: boolean,
 *   failedGroups: Array<[string, Array<object>]>,
 *   rejectedGroups: Array<{sessionId: string, attempts: Array<object>, status: number}>,
 * }>}
 */
export async function flushGroups(groups, postGroup) {
  const rejectedGroups = [];
  for (let i = 0; i < groups.length; i++) {
    const [sessionId, attempts] = groups[i];
    try {
      await postGroup(sessionId, attempts);
    } catch (error) {
      if (isRetriableSyncError(error)) {
        return { retriable: true, failedGroups: groups.slice(i), rejectedGroups };
      }
      // Permanent for this payload (deleted session, malformed body, …):
      // drop it from the queue but never silently — the caller must report it.
      rejectedGroups.push({ sessionId, attempts, status: error && error.status });
    }
  }
  return { retriable: false, failedGroups: [], rejectedGroups };
}

/**
 * Flatten groups back into the pending-queue item shape, preserving order —
 * the inverse of groupAttempts for requeueing failed groups.
 *
 * @param {Array<[string, Array<{node_id: string, correct: boolean, attempt_uuid: string}>]>} groups
 * @returns {Array<{session_id: string, node_id: string, correct: boolean, attempt_uuid: string}>}
 */
export function ungroupAttempts(groups) {
  const flat = [];
  for (const [sessionId, attempts] of groups) {
    for (const a of attempts) {
      flat.push({ session_id: sessionId, node_id: a.node_id, correct: a.correct, attempt_uuid: a.attempt_uuid,
        ...(a.session_generation != null ? { session_generation: a.session_generation } : {}) });
    }
  }
  return flat;
}
