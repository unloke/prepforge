// Train's adapter on the durable outbox (outbox.js): its live queue
// (trainState.trainSync), how a flush sends attempts one session at a time
// with the open session's position, what a refusal keeps for review, and the
// keepalive beacon at unload.

import { appState, trainState } from "../core/state.js";
import { hooks } from "../core/hooks.js";
import { localDateString, postJson, setStatus } from "../core/api.js";
import { CSRF_HEADER, readCsrfCookie } from "../csrf.js";
import { classifySyncError } from "../sync-errors.js";
import { setTrainSyncState } from "../train-entry.js";
import { flushGroups, groupAttempts, trainAttemptId, trainOutbox, ungroupAttempts } from "../train-outbox.js";

// Set once the outbox attaches this domain.
let trainQueue, persistTrainOutbox;

export const trainSync = {
  ...trainOutbox,
  idleMs: 4000,
  state: () => trainState.trainSync,
  hasWork: () => trainState.trainSync.pending.length || trainState.trainSync.dirty,
  pendingCount: () => trainState.trainSync.pending.length,
  flush: flushTrainSync,
  snapshot: () => ({ pending: trainState.trainSync.pending, rejected: trainState.trainRejected || [] }),
  restore(stored) {
    trainState.trainRejected = stored.rejected.concat(trainState.trainRejected || []);
    trainState.trainSync.pending = stored.pending.concat(trainState.trainSync.pending);
    if (trainState.trainSync.pending.length) {
      trainState.trainSync.dirty = true;
      setTrainSyncState("dirty");
      scheduleTrainSync();
    }
    return { pending: trainState.trainSync.pending.length, rejected: stored.rejected.length };
  },
  attach({ queue, persist }) {
    trainQueue = queue;
    persistTrainOutbox = persist;
  },
};

export function syncTrainNow() {
  return trainQueue.flush();
}

export function queueTrainAttempt(smart, nodeId, correct, hinted = false) {
  trainState.trainSync.pending.push({
    session_id: smart.sessionId,
    session_generation: smart.generation,
    node_id: nodeId,
    correct,
    ...(hinted ? { hinted: true } : {}),
    attempt_uuid: crypto.randomUUID(),
  });
  setTrainSyncState("dirty");
  scheduleTrainSync();
}

export function markTrainPositionDirty() {
  trainState.trainSync.dirty = true;
  setTrainSyncState("dirty");
  scheduleTrainSync();
}

export function scheduleTrainSync() {
  trainQueue.schedule();
}

function flushTrainSync(durableCheckpoint, isCurrent) {
  const sync = trainState.trainSync;
  const batch = sync.pending;
  sync.pending = [];
  sync.dirty = false;
  // Capture the session position; abandoned-session attempts retain their own target.
  const smart = trainState.smart;
  const position = smart ? { card_index: smart.cardIndex, queue: smart.queue.map((c) => c.encoded), state_version: smart.stateVersion } : null;
  const groups = groupAttempts(batch, smart ? smart.sessionId : null, smart?.generation);
  setTrainSyncState("syncing");

  return (async () => {
    await durableCheckpoint;
    if (!isCurrent()) return false;
    let lastError = null;
    const outcome = await flushGroups(groups, async (sessionId, attempts) => {
      if (!isCurrent()) throw new Error("Workspace changed");
      const generation = attempts.length ? attempts[0].session_generation : (smart?.sessionId === sessionId ? smart.generation : undefined);
      const body = { session_id: sessionId, session_generation: generation, attempts, local_date: localDateString() };
      if (smart && sessionId === smart.sessionId && generation === smart.generation) {
        Object.assign(body, position);
      }
      try {
        const result = await postJson("/api/train/smart/sync", body);
        if (isCurrent() && trainState.smart === smart && body.state_version != null) {
          if (result.state_applied) smart.stateVersion = result.state_version;
          else if (result.state_applied === false) {
            setStatus("Training session changed elsewhere. Resume it to sync your position.", { severity: "error" });
          }
        }
        if (isCurrent() && result.day_streak) appState.dayStreak = result.day_streak;
      } catch (error) {
        lastError = error;
        throw error;
      }
      });
    if (!isCurrent()) return false;
    // Preserve every rejection and tombstone all explicit server outcomes.
    const rejectedCount = (outcome.rejectedGroups || []).reduce(
      (n, group) => n + (group.attempts ? group.attempts.length : 0),
      0,
    );
    const unsettled = new Set([
      ...ungroupAttempts(outcome.failedGroups || []),
    ].map((attempt) => trainAttemptId(attempt)));
    const settledAttempts = batch
      .map((attempt) => trainAttemptId(attempt))
      .filter((id) => !unsettled.has(id));
    if (rejectedCount) {
      trainState.trainRejected = (trainState.trainRejected || []).concat(outcome.rejectedGroups);
    }
    if (settledAttempts.length) await persistTrainOutbox(settledAttempts);
    if (!isCurrent()) return false;
    const info = lastError ? classifySyncError(lastError) : null;
    const failedCount = outcome.failedGroups
      ? outcome.failedGroups.reduce((n, [, attempts]) => n + attempts.length, 0)
      : 0;
    if (!outcome.retriable) {
      trainQueue.resetRetry();
      if (rejectedCount) {
        setStatus(
          `${rejectedCount} training attempt${rejectedCount === 1 ? "" : "s"} could not be saved${
            failedCount ? `; ${failedCount} kept for retry` : ""
          }`,
          { severity: "error" },
        );
      }
      if (sync.pending.length || sync.dirty) {
        setTrainSyncState("dirty");
        scheduleTrainSync();
      } else if (rejectedCount) {
        setTrainSyncState("rejected");
      } else {
        setTrainSyncState("saved");
      }
      return rejectedCount === 0;
    }
    if (rejectedCount) {
      setStatus(
        `${rejectedCount} training attempt${rejectedCount === 1 ? "" : "s"} kept for review; ` +
          `${failedCount} will retry`,
        { severity: "error" },
      );
    }
    setTrainSyncState(info && info.pauseForAuth ? "blocked" : "error");
    // Requeue failed groups ahead of newer attempts and back off. SR deltas
    // are precious but small; they also flush on hide/unload and session end.
    sync.pending = ungroupAttempts(outcome.failedGroups).concat(sync.pending);
    persistTrainOutbox();
    // Only re-mark the position dirty if the current session's group is the
    // one that failed — other sessions carry no position payload.
    if (smart && smart === trainState.smart && outcome.failedGroups.some(([sessionId]) => sessionId === smart.sessionId)) {
      sync.dirty = true;
    }
    if (info && info.pauseForAuth) {
      // Sign-in re-arms the queue.
      hooks.authRequired?.();
      return false;
    }
    trainQueue.retry(info);
    return false;
  })();
}

export function beaconFlushTrain() {
  const sync = trainState.trainSync;
  void persistTrainOutbox(); // Unload cannot guarantee completion of an IDB transaction.
  if (!sync.pending.length && !sync.dirty) return;
  const token = readCsrfCookie();
  const smart = trainState.smart;
  const groups = groupAttempts(sync.pending, smart ? smart.sessionId : null, smart?.generation);
  for (const [sessionId, attempts] of groups) {
    const generation = attempts.length ? attempts[0].session_generation : (smart?.sessionId === sessionId ? smart.generation : undefined);
    const body = { session_id: sessionId, session_generation: generation, attempts, local_date: localDateString() };
    if (smart && sessionId === smart.sessionId && generation === smart.generation) {
      body.card_index = smart.cardIndex;
      body.state_version = smart.stateVersion;
      body.queue = smart.queue.map((c) => c.encoded);
    }
    try {
      fetch("/api/train/smart/sync", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...(token ? { [CSRF_HEADER]: token } : {}) },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch (_) {
      /* best-effort */
    }
  }
}
