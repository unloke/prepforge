import {
  buildAddId, buildDeleteId, clearDurableOutbox, createSyncQueue, flushGroups, groupAttempts,
  loadDurableOutbox, orderPendingBuildAdds, outboxHasWork, outboxIsQuiescent,
  trainAttemptId, ungroupAttempts,
} from "../sync-queue.js";
import { classifySyncError, describeSyncError } from "../sync-errors.js";

let appState, currentOwnerId, captureBuildContext, buildOpMatchesRepertoire, resolveBuildId, queuedBuildRevision, rebaseQueuedBuildRevision, postJson, setBuildSync, hasPendingBuildOpsFor, hydrateBuild, reapplyPendingBuildNodes, reapplyPendingBuildDeletes, selectBuildNode, setStatusError, setStatus, commitPendingUndos, readCsrfCookie, CSRF_HEADER, setTrainSyncState, localDateString, OUTBOX_TAB_ID, buildQueue, trainQueue;

export function createSyncController(deps) {
  ({ appState, currentOwnerId, captureBuildContext, buildOpMatchesRepertoire, resolveBuildId, queuedBuildRevision, rebaseQueuedBuildRevision, postJson, setBuildSync, hasPendingBuildOpsFor, hydrateBuild, reapplyPendingBuildNodes, reapplyPendingBuildDeletes, selectBuildNode, setStatusError, setStatus, commitPendingUndos, readCsrfCookie, CSRF_HEADER, setTrainSyncState, localDateString, OUTBOX_TAB_ID } = deps);
  const buildState = {
    get timer() { return appState.buildFlushTimer; },
    set timer(value) { appState.buildFlushTimer = value; },
    get flushing() { return appState.buildFlushing; },
    set flushing(value) { appState.buildFlushing = value; },
    get retry() { return appState.buildSyncRetry; },
    set retry(value) { appState.buildSyncRetry = value; },
  };
  const common = { owner: currentOwnerId, generation: () => appState.ownerGeneration,
    serialize: outboxSnapshot, tabId: OUTBOX_TAB_ID, onPersist(ok) {
      appState.outboxPersisted = ok;
      if (!ok && !appState.outboxStorageWarned) {
        appState.outboxStorageWarned = true;
        setStatus("This browser is not letting us store your unsynced edits — they stay in this tab only. Don't close it.", { severity: "warning" });
      }
    } };
  buildQueue = createSyncQueue({ ...common, key: "build", state: () => buildState,
    hasWork: () => appState.build && (appState.buildPending.length || appState.buildPendingDeletes.length),
    idleMs: 2000, flush: flushBuildMoves });
  trainQueue = createSyncQueue({ ...common, key: "train", state: () => appState.trainSync,
    hasWork: () => appState.trainSync.pending.length || appState.trainSync.dirty,
    idleMs: 4000, flush: flushTrainSync });
  return { scheduleBuildFlush, settleBuildOutbox, hardFlushBuild, beaconFlushBuild, queueTrainAttempt, markTrainPositionDirty, scheduleTrainSync, beaconFlushTrain,
    flushBuildMoves: buildQueue.flush, flushTrainSync: trainQueue.flush,
    persistOutbox, clearOutboxWhenQuiescent, restoreOutbox, flushAllPendingForSignOut,
  };
}

function scheduleBuildFlush() {
  buildQueue.schedule();
}

function flushBuildMoves(durableCheckpoint, ownsQueue) {
  const buildCurrent = captureBuildContext();
  const isCurrent = () => ownsQueue() && buildCurrent();
  // Drain this repertoire only; edits made during the request stay queued.
  const repertoireId = appState.build.repertoire_id;
  const batch = appState.buildPending.filter((m) => buildOpMatchesRepertoire(m, repertoireId));
  appState.buildPending = appState.buildPending.filter(
    (m) => !buildOpMatchesRepertoire(m, repertoireId),
  );
  const deleteBatch = appState.buildPendingDeletes.filter((entry) =>
    buildOpMatchesRepertoire(entry, repertoireId),
  );
  appState.buildPendingDeletes = appState.buildPendingDeletes.filter(
    (entry) => !buildOpMatchesRepertoire(entry, repertoireId),
  );
  // A delete of an in-flight add needs that add's acknowledged real ID.
  // Recover the add first; leaving the delete queued prevents tmp-only pruning
  // from silently settling a deletion whose server commit is still uncertain.
  const inFlightAdds = new Set(batch.map((op) => op.tempId));
  for (let i = deleteBatch.length - 1; i >= 0; i--) {
    if (inFlightAdds.has(resolveBuildId(deleteBatch[i]))) {
      appState.buildPendingDeletes.push(...deleteBatch.splice(i, 1));
    }
  }
  const deferredCount = [...appState.buildPending, ...appState.buildPendingDeletes]
    .filter((op) => !buildOpMatchesRepertoire(op, repertoireId)).length;
  if (deferredCount) {
    setStatus(
      `${deferredCount} edit${deferredCount === 1 ? "" : "s"} for another repertoire kept on this device — open that repertoire to save ${deferredCount === 1 ? "it" : "them"}.`,
    );
  }
  setBuildSync("syncing");

  return (async () => {
    let acknowledged = false;
    try {
      await durableCheckpoint;
      if (!isCurrent()) return false;
      // Deletes go FIRST: replaying a just-deleted move must create a fresh
      // node, not dedupe against the dying server one. A still-tmp id means the
      // node never reached the server (its pending add was cancelled) — drop it.
      const deleteIds = [
        ...new Set(deleteBatch.map(resolveBuildId).filter((id) => !String(id).startsWith("tmp-"))),
      ];
      let payload = null;
      if (deleteIds.length) {
        const beforeRevision = queuedBuildRevision([...deleteBatch, ...batch], appState.build);
        payload = await postJson("/api/build/delete-nodes", {
          repertoire_id: repertoireId,
          base_revision: beforeRevision,
          node_ids: deleteIds,
        });
        if (!ownsQueue()) return false;
        rebaseQueuedBuildRevision(batch, repertoireId, beforeRevision, payload.revision);
        await persistOutbox({ deletes: deleteBatch.map(buildDeleteId) });
        deleteBatch.length = 0;
      }
      if (batch.length) {
        // The add response supersedes the delete payload (it's newer truth).
        payload = await postJson("/api/build/add-moves", {
          repertoire_id: repertoireId,
          base_revision: queuedBuildRevision(batch, appState.build),
          moves: batch.map((m) => ({ tempId: m.tempId, parentRef: m.parentRef, uci: m.uci })),
        });
      }
      // Both batches can drain to nothing (e.g. deletes of never-flushed tmp
      // nodes): nothing reached the server, so there's nothing to reconcile.
      if (!payload) {
        buildQueue.resetRetry();
        // Those tmp-only deletes are resolved either way — tombstone them so a
        // second tab can't put them back in the durable queue.
        await persistOutbox({ deletes: deleteBatch.map(buildDeleteId) });
        if (hasPendingBuildOpsFor(repertoireId)) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else {
          await clearOutboxWhenQuiescent();
          setBuildSync("saved");
        }
        return true;
      }
      if (!ownsQueue()) return false;
      acknowledged = true;
      const idMap = payload.id_map || {};
      Object.assign(appState.buildIdMap, idMap);
      // Tombstone confirmed identities against stale-tab replay.
      const settled = {
        build: batch.map(buildAddId),
        deletes: deleteIds,
      };
      await persistOutbox(settled);

      // Translate the current selection + branch pick through tmp -> real.
      const prevSelection = appState.buildCurrentNodeId;
      const translatedSelection = idMap[prevSelection] || prevSelection;
      const branchPick = appState.buildBranchChoiceId
        ? idMap[appState.buildBranchChoiceId] || appState.buildBranchChoiceId
        : null;

      // Re-point this repertoire's queued children through acknowledged parent IDs.
      const stillPending = appState.buildPending.filter((m) =>
        buildOpMatchesRepertoire(m, repertoireId),
      );
      for (const m of stillPending) {
        if (idMap[m.parentRef]) {
          m.parentRef = idMap[m.parentRef];
          m.node.parent_id = m.parentRef;
        }
      }

      // hydrate needs a selection that exists in the authoritative payload; if the
      // user is sitting on a still-pending tmp node, pick a safe anchor now and
      // restore the tmp selection after we re-insert it below.
      const payloadHasSelection = payload.nodes.some((n) => n.id === translatedSelection);
      if (!isCurrent()) return true;
      await hydrateBuild(payload, payloadHasSelection ? translatedSelection : null);
      if (branchPick) appState.buildBranchChoiceId = branchPick;

      reapplyPendingBuildNodes(stillPending, idMap);
      // Subtrees deleted DURING the round-trip were resurrected by the hydrate
      // (the server still had them) — prune them again; their delete ops are
      // queued and flush next cycle.
      reapplyPendingBuildDeletes();

      // Restore the user's selection if it was a still-pending tmp node (now back
      // in the tree after reapply) and hydrate couldn't land on it.
      if (
        !payloadHasSelection &&
        appState.buildNodeById.has(prevSelection) &&
        prevSelection !== appState.buildCurrentNodeId
      ) {
        await selectBuildNode(prevSelection);
      }
      buildQueue.resetRetry();
      persistOutbox();
      if (hasPendingBuildOpsFor(repertoireId)) {
        setBuildSync("dirty");
        scheduleBuildFlush();
      } else {
        await clearOutboxWhenQuiescent();
        if (!isCurrent()) return false;
        setBuildSync("saved");
      }
      return true;
    } catch (error) {
      if (!ownsQueue()) return false;
      if (acknowledged) {
        // Rendering failed after the server confirmed persistence. Never replay
        // confirmed operations or misreport this as a failed network commit.
        persistOutbox();
        setStatusError(`Edits saved. Reload the repertoire to refresh it: ${error.message}`);
        if (hasPendingBuildOpsFor(repertoireId)) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else {
          setBuildSync("saved");
        }
        return true;
      }
      const info = classifySyncError(error);
      const inFlightCount = batch.length + deleteBatch.length;
      if (info.kind === "validation") {
        // Isolate invalid siblings without rejecting a legal parent/child chain.
        const { rejected, settled, idMap, payload } = await isolateRejectedBuildOps(
          batch,
          deleteBatch,
          repertoireId,
        );
        appState.buildRejected = (appState.buildRejected || []).concat(rejected);
        if (idMap && Object.keys(idMap).length) {
          // Ops that landed mid-isolation have real ids now; the local tree and
          // any queued children must be reconciled against them (R-05).
          Object.assign(appState.buildIdMap, idMap);
          const stillPending = appState.buildPending;
          for (const m of stillPending) {
            if (idMap[m.parentRef]) {
              m.parentRef = idMap[m.parentRef];
              m.node.parent_id = m.parentRef;
            }
          }
          if (payload) {
            await hydrateBuild(payload, null);
            reapplyPendingBuildNodes(stillPending, idMap);
            reapplyPendingBuildDeletes();
          }
        }
        await persistOutbox(settled);
        setStatusError(
          rejected.length
            ? `${rejected.length} edit${rejected.length === 1 ? "" : "s"} could not be saved and are kept for review. The rest saved.`
            : error.message,
        );
        if (hasPendingBuildOpsFor(repertoireId)) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else if (appState.buildRejected.length) {
          setBuildSync("rejected");
        } else {
          await clearOutboxWhenQuiescent();
          setBuildSync("saved");
        }
        return false;
      }
      // Requeue unconfirmed operations ahead of newer work, identities intact.
      appState.buildPending = batch.concat(appState.buildPending);
      appState.buildPendingDeletes = deleteBatch.concat(appState.buildPendingDeletes);
      persistOutbox();
      setStatus(describeSyncError(info, { count: inFlightCount }), info.kind === "conflict" ? "warning" : "info");
      if (info.pauseForAuth) {
        // R-04: 401 needs a sign-in, not a backoff timer. Stop sending until
        // loadSignedInWorkspace re-arms the flush after sign-in.
        appState.syncPausedForAuth = true;
        setBuildSync("blocked");
        return false;
      }
      if (info.kind === "conflict") {
        // D-02: base revision was stale — the draft stays queued; the user
        // reconciles (reload the tree) and the queue replays after it.
        setBuildSync("conflict");
        return false;
      }
      setBuildSync("error");
      buildQueue.retry(info);
      return false;
    }
  })();
}

async function isolateRejectedBuildOps(batch, deleteBatch, repertoireId) {
  const rejected = [];
  const settled = { build: [], deletes: [], train: [] };
  const idMap = {};
  let lastPayload = null;

  for (let i = 0; i < deleteBatch.length; i += 1) {
    const entry = deleteBatch[i];
    const id = resolveBuildId(entry);
    if (String(id).startsWith("tmp-")) {
      settled.deletes.push(buildDeleteId(entry)); // never reached the server
      continue;
    }
    try {
      const beforeRevision = queuedBuildRevision([...deleteBatch.slice(i), ...batch], appState.build);
      const payload = await postJson("/api/build/delete-nodes", {
        repertoire_id: repertoireId,
        base_revision: beforeRevision,
        node_ids: [id],
      });
      rebaseQueuedBuildRevision([...deleteBatch.slice(i + 1), ...batch], repertoireId, beforeRevision, payload.revision);
      settled.deletes.push(buildDeleteId(entry));
    } catch (err) {
      const info = classifySyncError(err);
      if (info.retriable) {
        // Sign-out/network blip mid-isolation: stop here and keep this delete
        // plus every later one queued for the next flush.
        appState.buildPendingDeletes = deleteBatch.slice(i).concat(appState.buildPendingDeletes);
        break;
      }
      settled.deletes.push(buildDeleteId(entry));
      rejected.push({ kind: "delete", id, message: err.message, status: err.status ?? null });
    }
  }

  const ordered = orderPendingBuildAdds(batch);
  for (let i = 0; i < ordered.length; i += 1) {
    const m = ordered[i];
    // A parent from this same isolation round now has a real id.
    const parentRef = idMap[m.parentRef] || resolveBuildId(m.parentRef);
    try {
      const beforeRevision = queuedBuildRevision(ordered.slice(i), appState.build);
      const payload = await postJson("/api/build/add-moves", {
        repertoire_id: repertoireId,
        base_revision: beforeRevision,
        moves: [{ tempId: m.tempId, parentRef, uci: m.uci }],
      });
      rebaseQueuedBuildRevision(ordered.slice(i + 1), repertoireId, beforeRevision, payload.revision);
      if (payload && payload.id_map) Object.assign(idMap, payload.id_map);
      if (payload && payload.nodes) lastPayload = payload;
      settled.build.push(buildAddId(m));
    } catch (err) {
      const info = classifySyncError(err);
      if (info.retriable) {
        appState.buildPending = ordered.slice(i).concat(appState.buildPending);
        break;
      }
      settled.build.push(buildAddId(m));
      rejected.push({
        kind: "add",
        tempId: m.tempId,
        uci: m.uci,
        message: err.message,
        status: err.status ?? null,
      });
    }
  }
  return { rejected, settled, idMap, payload: lastPayload };
}

async function settleBuildOutbox() {
  if (!appState.build) return;
  try {
    if (appState.buildFlushing) await appState.buildFlushing;
    if (appState.buildPending.length || appState.buildPendingDeletes.length) {
      clearTimeout(appState.buildFlushTimer);
      appState.buildFlushTimer = null;
      await buildQueue.flush();
    }
  } catch (_) {
    // the outbox retries on its own; the Library just shows server truth
  }
}

async function hardFlushBuild() {
  // Open undo windows must close first: server truth has to include those
  // deletes (or the undone restore) before any operation depends on it.
  commitPendingUndos();
  if (!appState.build) return;
  const repId = appState.build.repertoire_id;
  const ownerId = currentOwnerId();
  if (appState.buildFlushing) await appState.buildFlushing.catch(() => {});
  // R-02: drain THIS repertoire's ops. Ops queued for another tree are not
  // part of this request (and must not spin the loop) — they stay on the
  // device until their own repertoire is open.
  const hasWorkForThisRep = () =>
    appState.buildPending.some((m) => buildOpMatchesRepertoire(m, repId)) ||
    appState.buildPendingDeletes.some((entry) => buildOpMatchesRepertoire(entry, repId));
  while (hasWorkForThisRep()) {
    if (ownerId !== currentOwnerId() || appState.build?.repertoire_id !== repId) {
      throw new Error("Repertoire changed before sync completed ? reopen it and try again");
    }
    const ok = await buildQueue.flush();
    if (appState.buildFlushing) await appState.buildFlushing.catch(() => {});
    if (!ok) {
      throw new Error("Couldn't sync your latest moves — check your connection and try again");
    }
  }
}

function beaconFlushBuild() {
  // Close undo windows so their deletes ride this last-ditch flush (the rep
  // delete commit is itself keepalive-safe).
  commitPendingUndos();
  void persistOutbox(); // Best effort only at unload; normal flush checkpoints first.
  if (!appState.build) return;
  const repId = appState.build.repertoire_id;
  // R-02: only this repertoire's ops — a queued op for another tree must not
  // ride this keepalive into the open tree.
  const pending = appState.buildPending.filter((m) => buildOpMatchesRepertoire(m, repId));
  const pendingDeletes = appState.buildPendingDeletes.filter((entry) =>
    buildOpMatchesRepertoire(entry, repId),
  );
  if (!pending.length && !pendingDeletes.length) return;
  const token = readCsrfCookie();
  const send = (path, payload) => {
    try {
      fetch(path, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...(token ? { [CSRF_HEADER]: token } : {}) },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch (_) {
      /* best-effort */
    }
  };
  // Same order as the real flush: deletes before adds. Both fire-and-forget;
  // the next page load re-hydrates from server truth regardless.
  const deleteIds = [
    ...new Set(
      pendingDeletes.map(resolveBuildId).filter((id) => !String(id).startsWith("tmp-"))
    ),
  ];
  if (deleteIds.length) {
    send("/api/build/delete-nodes", {
      repertoire_id: repId,
      base_revision: queuedBuildRevision([...pendingDeletes, ...pending], appState.build),
      node_ids: deleteIds,
    });
  }
  if (pending.length) {
    send("/api/build/add-moves", {
      repertoire_id: repId,
      base_revision: queuedBuildRevision(pending, appState.build),
      moves: pending.map((m) => ({
        tempId: m.tempId,
        parentRef: m.parentRef,
        uci: m.uci,
      })),
    });
  }
}

function queueTrainAttempt(smart, nodeId, correct) {
  appState.trainSync.pending.push({
    session_id: smart.sessionId,
    session_generation: smart.generation,
    node_id: nodeId,
    correct,
    attempt_uuid: crypto.randomUUID(),
  });
  setTrainSyncState("dirty");
  scheduleTrainSync();
}

function markTrainPositionDirty() {
  appState.trainSync.dirty = true;
  setTrainSyncState("dirty");
  scheduleTrainSync();
}

function scheduleTrainSync() {
  trainQueue.schedule();
}

function flushTrainSync(durableCheckpoint, isCurrent) {
  const sync = appState.trainSync;
  const batch = sync.pending;
  sync.pending = [];
  sync.dirty = false;
  // Capture the session position; abandoned-session attempts retain their own target.
  const smart = appState.smart;
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
        if (isCurrent() && appState.smart === smart && body.state_version != null) {
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
      appState.trainRejected = (appState.trainRejected || []).concat(outcome.rejectedGroups);
    }
    if (settledAttempts.length) await persistOutbox({ train: settledAttempts });
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
        await clearOutboxWhenQuiescent();
        if (!isCurrent()) return false;
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
    persistOutbox();
    // Only re-mark the position dirty if the current session's group is the
    // one that failed — other sessions carry no position payload.
    if (smart && smart === appState.smart && outcome.failedGroups.some(([sessionId]) => sessionId === smart.sessionId)) {
      sync.dirty = true;
    }
    if (info && info.pauseForAuth) {
      // Sign-in re-arms the queue.
      return false;
    }
    trainQueue.retry(info);
    return false;
  })();
}

function beaconFlushTrain() {
  const sync = appState.trainSync;
  void persistOutbox(); // Unload cannot guarantee completion of an IDB transaction.
  if (!sync.pending.length && !sync.dirty) return;
  const token = readCsrfCookie();
  const smart = appState.smart;
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

function outboxSnapshot() {
  return {
    build: { pending: appState.buildPending, pendingDeletes: appState.buildPendingDeletes,
      idMap: appState.buildIdMap, rejected: appState.buildRejected || [] },
    train: { pending: appState.trainSync.pending, rejected: appState.trainRejected || [] },
  };
}

function persistOutbox(settled = null) {
  return buildQueue.persist(settled);
}

async function clearOutboxWhenQuiescent() {
  const owner = currentOwnerId();
  if (!outboxIsQuiescent(await loadDurableOutbox(owner))) {
    await persistOutbox();
    return false;
  }
  await clearDurableOutbox(owner);
  return owner === currentOwnerId();
}

async function restoreOutbox() {
  const owner = currentOwnerId(), generation = appState.ownerGeneration;
  const outbox = await loadDurableOutbox(owner);
  if (owner !== currentOwnerId() || generation !== appState.ownerGeneration) return null;
  const rejectedCount =
    (outbox.build.rejected || []).length + (outbox.train.rejected || []).length;
  if (!outboxHasWork(outbox) && !rejectedCount) return null;
  appState.buildPending = outbox.build.pending.concat(appState.buildPending);
  appState.buildPendingDeletes = outbox.build.pendingDeletes.concat(
    appState.buildPendingDeletes,
  );
  Object.assign(appState.buildIdMap, outbox.build.idMap);
  appState.buildRejected = (outbox.build.rejected || []).concat(appState.buildRejected || []);
  appState.trainRejected = (outbox.train.rejected || []).concat(appState.trainRejected || []);
  appState.trainSync.pending = outbox.train.pending.concat(appState.trainSync.pending);
  if (appState.trainSync.pending.length) {
    appState.trainSync.dirty = true;
    setTrainSyncState("dirty");
    scheduleTrainSync();
  }
  return {
    build: appState.buildPending.length + appState.buildPendingDeletes.length,
    train: appState.trainSync.pending.length,
    rejected: rejectedCount,
  };
}

async function flushAllPendingForSignOut() {
  await persistOutbox();
  clearTimeout(appState.buildFlushTimer);
  appState.buildFlushTimer = null;
  clearTimeout(appState.trainSync.timer);
  appState.trainSync.timer = null;
  await Promise.all([
    buildQueue.flush().catch(() => false),
    trainQueue.flush().catch(() => false),
  ]);
  await persistOutbox();
  return {
    pending:
      appState.buildPending.length +
      appState.buildPendingDeletes.length +
      appState.trainSync.pending.length,
  };
}
