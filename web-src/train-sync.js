// Pure core of the local-first Train sync flush (app.js wires state/timers).
//
// The server's record_attempt is NOT idempotent, so the retry unit is the
// session group: a group that POSTed successfully must never be requeued when
// a later group fails. 4xx (e.g. the session's repertoire was deleted) drops
// only that group — there is nothing to retry into — while other sessions'
// attempts still land. Network/5xx stops the flush and reports the failing
// group plus everything not yet sent, so the caller can requeue exactly those.

/**
 * Group flat pending attempts by session, preserving play order within each
 * group. The current session always gets a group — even an empty one — so a
 * flush with only a dirty position still carries it.
 *
 * @param {Array<{session_id: string, node_id: string, correct: boolean}>} pending
 * @param {string|null} currentSessionId
 * @returns {Array<[string, Array<{node_id: string, correct: boolean}>]>}
 */
export function groupAttempts(pending, currentSessionId) {
  const bySession = new Map();
  for (const item of pending) {
    if (!bySession.has(item.session_id)) bySession.set(item.session_id, []);
    bySession.get(item.session_id).push({ node_id: item.node_id, correct: item.correct });
  }
  if (currentSessionId && !bySession.has(currentSessionId)) {
    bySession.set(currentSessionId, []);
  }
  return [...bySession];
}

/**
 * POST each group in order via `postGroup(sessionId, attempts)`.
 *
 * - success: move on.
 * - error with 4xx status: drop the group, keep going.
 * - any other error: stop; the failing group and all unsent groups are
 *   returned as `failedGroups` with `retriable: true`.
 *
 * @param {Array<[string, Array<{node_id: string, correct: boolean}>]>} groups
 * @param {(sessionId: string, attempts: Array<object>) => Promise<void>} postGroup
 * @returns {Promise<{retriable: boolean, failedGroups: Array<[string, Array<object>]>}>}
 */
export async function flushGroups(groups, postGroup) {
  for (let i = 0; i < groups.length; i++) {
    const [sessionId, attempts] = groups[i];
    try {
      await postGroup(sessionId, attempts);
    } catch (error) {
      const status = error && error.status;
      if (status && status >= 400 && status < 500) continue;
      return { retriable: true, failedGroups: groups.slice(i) };
    }
  }
  return { retriable: false, failedGroups: [] };
}

/**
 * Flatten groups back into the pending-queue item shape, preserving order —
 * the inverse of groupAttempts for requeueing failed groups.
 *
 * @param {Array<[string, Array<{node_id: string, correct: boolean}>]>} groups
 * @returns {Array<{session_id: string, node_id: string, correct: boolean}>}
 */
export function ungroupAttempts(groups) {
  const flat = [];
  for (const [sessionId, attempts] of groups) {
    for (const a of attempts) {
      flat.push({ session_id: sessionId, node_id: a.node_id, correct: a.correct });
    }
  }
  return flat;
}
