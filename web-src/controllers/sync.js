// Wires the features that write local-first into the durable outbox. The
// outbox itself (outbox.js) knows no feature; each feature's adapter
// (build-sync.js, train-sync.js) knows only its own queue and endpoints.

import { createOutbox } from "../outbox.js";
import { appState } from "../core/state.js";
import { OUTBOX_TAB_ID, currentOwnerId, setStatus } from "../core/api.js";
import { beaconFlushBuild, bindBuildSession, buildSync, discardBuildOps, hardFlushBuild, scheduleBuildFlush, settleBuildOutbox,
  syncBuildNow } from "./build-sync.js";
import { beaconFlushTrain, markTrainPositionDirty, queueTrainAttempt, scheduleTrainSync, syncTrainNow,
  trainSync } from "./train-sync.js";

// The shell hands in the Build session's hydrate and its load-generation check.
export function createSyncController(build) {
  bindBuildSession(build);
  const outbox = createOutbox({
    domains: [buildSync, trainSync],
    owner: currentOwnerId,
    generation: () => appState.ownerGeneration,
    tabId: OUTBOX_TAB_ID,
    onPersist(ok) {
      appState.outboxPersisted = ok;
      if (!ok && !appState.outboxStorageWarned) {
        appState.outboxStorageWarned = true;
        setStatus("This browser is not letting us store your unsynced edits — they stay in this tab only. Don't close it.", { severity: "warning" });
      }
    },
  });
  async function restoreOutbox() {
    const restored = await outbox.restore();
    return restored && { build: restored.build, train: restored.train.pending, rejected: restored.train.rejected };
  }
  return { scheduleBuildFlush, settleBuildOutbox, hardFlushBuild, beaconFlushBuild, discardBuildOps,
    queueTrainAttempt, markTrainPositionDirty, scheduleTrainSync, beaconFlushTrain,
    flushBuildMoves: syncBuildNow, flushTrainSync: syncTrainNow,
    persistOutbox: () => outbox.persist(), restoreOutbox, flushAllPendingForSignOut: outbox.drain,
  };
}
