// What a Build autosave sends and how its answer lands on the open tree.
//
// The open tree already shows its own edits, so a flush sends ``since`` (the
// revision that tree is at) and the server answers with only what changed after
// it: the written nodes, the removed ids, the id map and the new revision. That
// is about a kilobyte where the whole tree was megabytes on a big repertoire.
// A flush for a repertoire this tab is not showing asks for no tree at all.

import { MAX_ADD_MOVES_BATCH } from "./generated/shared-constants.js";
import { buildState } from "./core/state.js";
import { postJson } from "./core/api.js";
import { applyBuildChanges } from "./build-live.js";
import { buildRole } from "./share-roles.js";
import { reloadOpenBuildTree } from "./build-entry.js";
import { orderPendingBuildAdds } from "./sync-queue.js";

// Past any real revision: the server answers with the revision and role only.
export const NO_TREE_SINCE = Number.MAX_SAFE_INTEGER;

// The ``since`` to send for a flush of this repertoire.
export function flushSince(repertoireId) {
  const build = buildState.build;
  if (!build || build.repertoire_id !== repertoireId || build.optimistic) return NO_TREE_SINCE;
  return Number.isInteger(build.revision) ? build.revision : NO_TREE_SINCE;
}

// Post queued adds in batches the server accepts. A later batch's moves may hang
// off an earlier batch's temp ids, which have real ids by then. The answer is the
// last batch's (it reports everything since ``since``) with every id map and drop.
export async function postBuildAdds(repertoireId, batch, since, post = postJson) {
  const ordered = batch.length > MAX_ADD_MOVES_BATCH ? orderPendingBuildAdds(batch) : batch;
  const idMap = {};
  const dropped = [];
  let reply = null;
  for (let start = 0; start < ordered.length; start += MAX_ADD_MOVES_BATCH) {
    const moves = ordered.slice(start, start + MAX_ADD_MOVES_BATCH).map((m) => ({
      tempId: m.tempId, parentRef: idMap[m.parentRef] || m.parentRef, uci: m.uci,
    }));
    reply = await post("/api/build/add-moves", { repertoire_id: repertoireId, since, moves });
    Object.assign(idMap, reply?.id_map || {});
    dropped.push(...(reply?.dropped || []));
  }
  return reply && { ...reply, id_map: idMap, dropped };
}

// Land a flush answer on the open tree: a whole payload (an old server, or a
// flush sent without ``since``) re-hydrates; a delta is patched in; a delta the
// tree can't take (the log no longer reaches back, or this caller's role
// changed) re-reads the tree.
export async function applyFlushReply(reply, hydrate) {
  const build = buildState.build;
  if (!reply || !build) return;
  const selected = buildState.buildCurrentNodeId;
  if (reply.repertoire_id) {
    await hydrate(reply, selected);
    return;
  }
  if (reply.reset || (reply.role && reply.role !== buildRole(build))) {
    await reloadOpenBuildTree();
    return;
  }
  const { payload, selection } = applyBuildChanges(build, reply, selected);
  // A selected unsynced move keeps its temp id: hydrate resolves it.
  await hydrate(payload, String(selected).startsWith("tmp-") ? selected : selection);
}
