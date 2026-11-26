// Train's slice of the durable outbox: queued attempts (identified by the
// server-side dedupe UUID each carries), rejected attempt groups kept for the
// user to review, and tombstones for settled attempts. Settling is a list of
// attempt ids. An attempt in a rejected group never returns to pending.

import { asArray, mergeById, tombstones } from "./outbox-state.js";
import { classifySyncError } from "./sync-errors.js";

export function trainAttemptId(entry) {
  return String(entry?.attempt_uuid || "");
}

function rejectedId(entry) {
  try {
    return JSON.stringify(entry);
  } catch (_) {
    return "";
  }
}

function mergeTrainOutbox(stored, incoming, settled) {
  const base = stored || {};
  const next = incoming || {};
  const done = tombstones(base.settled, settled);
  for (const group of [...asArray(base.rejected), ...asArray(next.rejected)]) {
    for (const attempt of asArray(group.attempts)) {
      done.add(trainAttemptId({ ...attempt, session_id: group.sessionId }));
    }
  }
  const keep = (entry) => !done.has(trainAttemptId(entry));
  return {
    pending: mergeById(asArray(base.pending).filter(keep), asArray(next.pending).filter(keep), trainAttemptId),
    // Rejected operations remain available until the user resolves them.
    rejected: mergeById(asArray(base.rejected), asArray(next.rejected), rejectedId),
    settled: [...done],
  };
}

export const trainOutbox = { key: "train", merge: mergeTrainOutbox };

// Attempts go to the server one session at a time, in play order.
export function groupAttempts(pending, currentSessionId, currentGeneration) {
  const bySession = new Map();
  const key = (id, generation) => JSON.stringify([id, generation ?? null]);
  for (const item of pending) {
    const k = key(item.session_id, item.session_generation);
    if (!bySession.has(k)) bySession.set(k, [item.session_id, []]);
    bySession.get(k)[1].push({ node_id: item.node_id, correct: item.correct, attempt_uuid: item.attempt_uuid,
      ...(item.hinted ? { hinted: true } : {}),
      ...(item.session_generation != null ? { session_generation: item.session_generation } : {}) });
  }
  const currentKey = key(currentSessionId, currentGeneration);
  if (currentSessionId && !bySession.has(currentKey)) bySession.set(currentKey, [currentSessionId, []]);
  return [...bySession.values()];
}

export function isRetriableSyncError(error) {
  return classifySyncError(error).retriable;
}

// A retriable failure stops the run and keeps that group and every later one;
// any other failure rejects that group and carries on.
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
      rejectedGroups.push({ sessionId, attempts, status: error && error.status });
    }
  }
  return { retriable: false, failedGroups: [], rejectedGroups };
}

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
