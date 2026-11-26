// Build's adapter on the durable outbox (outbox.js): its live queue
// (buildState.buildPending / buildPendingDeletes / buildIdMap), how a flush
// sends it (deletes first, then adds, one repertoire at a time), how the answer
// lands on the open tree, and the keepalive beacon at unload.

import { appState, buildState } from "../core/state.js";
import { hooks } from "../core/hooks.js";
import { currentOwnerId, setStatus, setStatusError } from "../core/api.js";
import { CSRF_HEADER, readCsrfCookie } from "../csrf.js";
import { classifySyncError, describeSyncError } from "../sync-errors.js";
import { commitPendingUndos } from "../undo.js";
import { buildOpMatchesRepertoire, hasPendingBuildOpsFor, resolveBuildId } from "../build-entry.js";
import { invalidateBuildTree } from "../build-tree.js";
import { setBuildSync } from "../train-entry.js";
import { captureBuildContext, hydrateBuild } from "../core/app-context.js";
import { applyFlushReply, flushSince, postBuildAdds } from "../build-flush.js";
import { isolateRejectedBuildOps } from "../build-isolate.js";
import { buildAddId, buildDeleteId, buildOutbox } from "../build-outbox.js";
import { postBuildWrite } from "../build-write.js";

// Set once the outbox attaches this domain.
let buildQueue, persistBuildOutbox;

const buildQueueState = {
  get timer() { return buildState.buildFlushTimer; },
  set timer(value) { buildState.buildFlushTimer = value; },
  get flushing() { return buildState.buildFlushing; },
  set flushing(value) { buildState.buildFlushing = value; },
  get retry() { return buildState.buildSyncRetry; },
  set retry(value) { buildState.buildSyncRetry = value; },
};

const hasBuildPending = () => buildState.buildPending.length || buildState.buildPendingDeletes.length;

export const buildSync = {
  ...buildOutbox,
  idleMs: 2000,
  state: () => buildQueueState,
  hasWork: hasBuildPending,
  pendingCount: () => buildState.buildPending.length + buildState.buildPendingDeletes.length,
  flush: flushBuildMoves,
  snapshot: () => ({ pending: buildState.buildPending, pendingDeletes: buildState.buildPendingDeletes,
    idMap: buildState.buildIdMap }),
  restore(stored) {
    buildState.buildPending = stored.pending.concat(buildState.buildPending);
    buildState.buildPendingDeletes = stored.pendingDeletes.concat(buildState.buildPendingDeletes);
    Object.assign(buildState.buildIdMap, stored.idMap);
    return buildState.buildPending.length + buildState.buildPendingDeletes.length;
  },
  attach({ queue, persist }) {
    buildQueue = queue;
    persistBuildOutbox = persist;
  },
};

export function syncBuildNow() {
  return buildQueue.flush();
}

// A deleted repertoire's queued edits go with it, tombstoned so the durable
// outbox can't bring them back.
export function discardBuildOps(repertoireId) {
  const adds = buildState.buildPending.filter((m) => buildOpMatchesRepertoire(m, repertoireId));
  const deletes = buildState.buildPendingDeletes.filter((entry) => buildOpMatchesRepertoire(entry, repertoireId));
  buildState.buildPending = buildState.buildPending.filter((m) => !adds.includes(m));
  buildState.buildPendingDeletes = buildState.buildPendingDeletes.filter((entry) => !deletes.includes(entry));
  return persistBuildOutbox({ adds: adds.map(buildAddId), deletes: deletes.map(buildDeleteId) });
}

export function scheduleBuildFlush() {
  buildQueue.schedule();
}

function flushBuildMoves(durableCheckpoint, ownsQueue) {
  // The open tree first, then any other repertoire's queued edits, which save
  // without being shown. Edits made during the request stay queued.
  const open = buildState.build?.repertoire_id;
  const repertoireId = hasPendingBuildOpsFor(open)
    ? open
    : (buildState.buildPending[0] || buildState.buildPendingDeletes[0]).repertoire_id;
  const buildCurrent = captureBuildContext();
  const isCurrent = () => ownsQueue() && buildCurrent() && buildState.build?.repertoire_id === repertoireId;
  const batch = buildState.buildPending.filter((m) => buildOpMatchesRepertoire(m, repertoireId));
  buildState.buildPending = buildState.buildPending.filter(
    (m) => !buildOpMatchesRepertoire(m, repertoireId),
  );
  const deleteBatch = buildState.buildPendingDeletes.filter((entry) =>
    buildOpMatchesRepertoire(entry, repertoireId),
  );
  buildState.buildPendingDeletes = buildState.buildPendingDeletes.filter(
    (entry) => !buildOpMatchesRepertoire(entry, repertoireId),
  );
  // A delete of an in-flight add needs that add's acknowledged real ID.
  // Recover the add first; leaving the delete queued prevents tmp-only pruning
  // from silently settling a deletion whose server commit is still uncertain.
  const inFlightAdds = new Set(batch.map((op) => op.tempId));
  for (let i = deleteBatch.length - 1; i >= 0; i--) {
    if (inFlightAdds.has(resolveBuildId(deleteBatch[i]))) {
      buildState.buildPendingDeletes.push(...deleteBatch.splice(i, 1));
    }
  }
  const hasBuildWork = () => buildState.buildPending.length || buildState.buildPendingDeletes.length;
  setBuildSync("syncing");
  const since = flushSince(repertoireId); // one ``since`` for both requests: the last answer covers both

  return (async () => {
    let acknowledged = false;
    try {
      await durableCheckpoint;
      if (!ownsQueue()) return false;
      // Deletes go FIRST: replaying a just-deleted move must create a fresh
      // node, not dedupe against the dying server one. A still-tmp id means the
      // node never reached the server (its pending add was cancelled) — drop it.
      const deleteIds = [
        ...new Set(deleteBatch.map(resolveBuildId).filter((id) => !String(id).startsWith("tmp-"))),
      ];
      let payload = null;
      if (deleteIds.length) {
        payload = await postBuildWrite("/api/build/delete-nodes", {
          repertoire_id: repertoireId, since,
          node_ids: deleteIds,
        });
        if (!ownsQueue()) return false;
        await persistBuildOutbox({ deletes: deleteBatch.map(buildDeleteId) });
        deleteBatch.length = 0;
      }
      // The add answer supersedes the delete's: it reports both.
      if (batch.length) payload = await postBuildAdds(repertoireId, batch, since, { owns: ownsQueue });
      // Another account took over mid-flush: what was not sent stays in this
      // account's durable outbox.
      if (!ownsQueue()) return false;
      // Both batches can drain to nothing (e.g. deletes of never-flushed tmp
      // nodes): nothing reached the server, so there's nothing to reconcile.
      if (!payload) {
        buildQueue.resetRetry();
        // Those tmp-only deletes are resolved either way — tombstone them so a
        // second tab can't put them back in the durable queue.
        await persistBuildOutbox({ deletes: deleteBatch.map(buildDeleteId) });
        if (!ownsQueue()) return false;
        if (hasBuildWork()) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else {
          setBuildSync("saved");
        }
        return true;
      }
      if (!ownsQueue()) return false;
      acknowledged = true;
      const idMap = payload.id_map || {};
      Object.assign(buildState.buildIdMap, idMap);
      // Tombstone confirmed identities against stale-tab replay.
      const settled = {
        adds: batch.map(buildAddId),
        deletes: deleteIds,
      };
      await persistBuildOutbox(settled);
      if (!ownsQueue()) return false;

      // Re-point this repertoire's queued children through acknowledged parent IDs.
      for (const m of buildState.buildPending) {
        if (buildOpMatchesRepertoire(m, repertoireId) && idMap[m.parentRef]) {
          m.parentRef = idMap[m.parentRef];
          m.node.parent_id = m.parentRef;
          invalidateBuildTree(buildState.build);
        }
      }

      // Hydration merges queued edits before selecting, so an unsaved child
      // remains visible throughout reconciliation.
      if (isCurrent()) {
        await applyFlushReply(payload, hydrateBuild);
      }
      if (!ownsQueue()) return false;
      // Moves whose line another device deleted first: the delete won.
      const dropped = payload.dropped?.length || 0;
      if (dropped) {
        setStatus(`${dropped} move${dropped === 1 ? "" : "s"} not saved: line deleted elsewhere`, { severity: "warning" });
      }
      buildQueue.resetRetry();
      if (hasBuildWork()) {
        setBuildSync("dirty");
        scheduleBuildFlush();
      } else {
        setBuildSync("saved");
      }
      return true;
    } catch (error) {
      if (!ownsQueue()) return false;
      if (acknowledged) {
        // Rendering failed after the server confirmed persistence. Never replay
        // confirmed operations or misreport this as a failed network commit.
        persistBuildOutbox();
        setStatusError(`Edits saved. Reload the repertoire to refresh it: ${error.message}`);
        if (hasBuildWork()) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else {
          setBuildSync("saved");
        }
        return true;
      }
      const info = classifySyncError(error);
      const inFlightCount = batch.length + deleteBatch.length;
      if (info.kind === "validation" || info.kind === "conflict" || info.kind === "forbidden") {
        // Drop what the server refused without rejecting a legal parent/child chain.
        const { rejected, settled, idMap, payload } = await isolateRejectedBuildOps(
          batch, deleteBatch, repertoireId, error, since, ownsQueue,
        );
        if (!ownsQueue()) return false;
        if (idMap && Object.keys(idMap).length) {
          // Ops that landed mid-isolation have real ids now; the local tree and
          // any queued children must be reconciled against them (R-05).
          Object.assign(buildState.buildIdMap, idMap);
          const stillPending = buildState.buildPending;
          for (const m of stillPending) {
            if (idMap[m.parentRef]) {
              m.parentRef = idMap[m.parentRef];
              m.node.parent_id = m.parentRef;
              invalidateBuildTree(buildState.build);
            }
          }
          if (payload && isCurrent()) await applyFlushReply(payload, hydrateBuild);
        }
        // Rejected edits are reported here once and dropped: the server will
        // never accept them, and there is nothing to review them with.
        await persistBuildOutbox(settled);
        if (!ownsQueue()) return false;
        setStatusError(
          rejected.length
            ? `${rejected.length} edit${rejected.length === 1 ? "" : "s"} could not be saved: ${rejected[0].message}`
            : error.message,
        );
        if (hasBuildWork()) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else {
          setBuildSync("saved");
        }
        return false;
      }
      // Requeue unconfirmed operations ahead of newer work, identities intact.
      buildState.buildPending = batch.concat(buildState.buildPending);
      buildState.buildPendingDeletes = deleteBatch.concat(buildState.buildPendingDeletes);
      persistBuildOutbox();
      setStatus(describeSyncError(info, { count: inFlightCount }));
      if (info.pauseForAuth) {
        // R-04: 401 needs a sign-in, not a backoff timer. Stop sending until
        // loadSignedInWorkspace re-arms the flush after sign-in.
        appState.syncPausedForAuth = true;
        setBuildSync("blocked");
        hooks.authRequired?.();
        return false;
      }
      setBuildSync("error");
      buildQueue.retry(info);
      return false;
    }
  })();
}

export async function settleBuildOutbox() {
  if (!buildState.build) return;
  try {
    if (buildState.buildFlushing) await buildState.buildFlushing;
    if (buildState.buildPending.length || buildState.buildPendingDeletes.length) {
      clearTimeout(buildState.buildFlushTimer);
      buildState.buildFlushTimer = null;
      await buildQueue.flush();
    }
  } catch (_) {
    // the outbox retries on its own; the Library just shows server truth
  }
}

export async function hardFlushBuild() {
  // Open undo windows must close first: server truth has to include those
  // deletes (or the undone restore) before any operation depends on it.
  commitPendingUndos();
  if (!buildState.build) return;
  const repId = buildState.build.repertoire_id;
  const ownerId = currentOwnerId();
  if (buildState.buildFlushing) await buildState.buildFlushing.catch(() => {});
  // R-02: drain THIS repertoire's ops. Ops queued for another tree are not
  // part of this request (and must not spin the loop) — they stay on the
  // device until their own repertoire is open.
  const hasWorkForThisRep = () =>
    buildState.buildPending.some((m) => buildOpMatchesRepertoire(m, repId)) ||
    buildState.buildPendingDeletes.some((entry) => buildOpMatchesRepertoire(entry, repId));
  while (hasWorkForThisRep()) {
    if (ownerId !== currentOwnerId() || buildState.build?.repertoire_id !== repId) {
      throw new Error("Repertoire changed before sync completed ? reopen it and try again");
    }
    const ok = await buildQueue.flush();
    if (buildState.buildFlushing) await buildState.buildFlushing.catch(() => {});
    if (!ok) {
      throw new Error("Couldn't sync your latest moves — check your connection and try again");
    }
  }
}

export function beaconFlushBuild() {
  // Close undo windows so their deletes ride this last-ditch flush (the rep
  // delete commit is itself keepalive-safe).
  commitPendingUndos();
  void persistBuildOutbox(); // Best effort only at unload; normal flush checkpoints first.
  if (!buildState.build) return;
  const repId = buildState.build.repertoire_id;
  // R-02: only this repertoire's ops — a queued op for another tree must not
  // ride this keepalive into the open tree.
  const pending = buildState.buildPending.filter((m) => buildOpMatchesRepertoire(m, repId));
  const pendingDeletes = buildState.buildPendingDeletes.filter((entry) =>
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
    send("/api/build/delete-nodes", { repertoire_id: repId, node_ids: deleteIds });
  }
  if (pending.length) {
    send("/api/build/add-moves", {
      repertoire_id: repId,
      moves: pending.map((m) => ({
        tempId: m.tempId,
        parentRef: m.parentRef,
        uci: m.uci,
      })),
    });
  }
}
