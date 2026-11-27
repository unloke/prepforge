// What a Build autosave sends and how its answer lands on the open tree.
//
// The open tree already shows its own edits, so a flush sends ``since`` (the
// revision that tree is at) and the server answers with only what changed after
// it: the written nodes, the removed ids, the id map and the new revision. That
// is about a kilobyte where the whole tree was megabytes on a big repertoire.
// A flush for a repertoire this tab is not showing asks for no tree at all.

import { MAX_ADD_MOVES_BATCH, MAX_PLAN_DEPTH } from "./generated/shared-constants.js";
import { buildState } from "./core/state.js";
import { postBuildWrite } from "./build-write.js";
import { applyBuildChanges } from "./build-live.js";
import { buildRole } from "./share-roles.js";
import { reloadOpenBuildTree } from "./build-entry.js";
import { orderPendingBuildAdds } from "./build-outbox.js";

// Past any real revision: the server answers with the revision and role only.
export const NO_TREE_SINCE = Number.MAX_SAFE_INTEGER;

// The ``since`` to send for a flush of this repertoire.
export function flushSince(repertoireId) {
  const build = buildState.build;
  if (!build || build.repertoire_id !== repertoireId || build.optimistic) return NO_TREE_SINCE;
  return Number.isInteger(build.revision) ? build.revision : NO_TREE_SINCE;
}

// Split queued adds into batches the server accepts: at most
// MAX_ADD_MOVES_BATCH moves, and no line longer than MAX_PLAN_DEPTH from a node
// that already exists. A move whose parent is in an earlier batch hangs off a
// real id by the time its batch is sent, so its line starts again from 1.
export function splitBuildAdds(batch) {
  const batches = [];
  let current = [];
  let depth = new Map();
  for (const move of orderPendingBuildAdds(batch)) {
    let length = (depth.get(move.parentRef) || 0) + 1;
    if (current.length >= MAX_ADD_MOVES_BATCH || length > MAX_PLAN_DEPTH) {
      batches.push(current);
      current = [];
      depth = new Map();
      length = 1;
    }
    current.push(move);
    depth.set(move.tempId, length);
  }
  if (current.length) batches.push(current);
  return batches;
}

// Post queued adds batch by batch. A later batch's moves may hang off an earlier
// batch's temp ids, which have real ids by then. The answer is the last batch's
// (it reports everything since ``since``) with every id map and drop. ``owns``
// is asked before each batch: once the queue is no longer this account's (a
// sign-out or another sign-in mid-flush), nothing more goes out under the new
// session, and ``unsent`` counts what was held back.
export async function postBuildAdds(repertoireId, batch, since, { post = postBuildWrite, owns = () => true } = {}) {
  const batches = splitBuildAdds(batch);
  const idMap = {};
  const dropped = [];
  let reply = null;
  for (let index = 0; index < batches.length; index += 1) {
    if (!owns()) {
      const unsent = batches.slice(index).reduce((total, part) => total + part.length, 0);
      return { ...(reply || {}), id_map: idMap, dropped, unsent };
    }
    const moves = batches[index].map((m) => ({
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
