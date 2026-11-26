// A Build autosave the server refused: find what it refused, report it once,
// and save everything else.
//
// The server names a rejected move (400 ``move_rejected`` with its temp id), so
// that move and the moves played after it on its line are dropped and the rest
// go back in one request. A refusal that names no move (an older server, or a
// batch-wide problem) falls back to one request per move. Losing edit rights
// (403 that is not a stale security token) rejects the whole batch at once: no
// single move would land, and resending each one only hits the rate limit.

import { postJson } from "./core/api.js";
import { buildState } from "./core/state.js";
import { classifySyncError } from "./sync-errors.js";
import { orderPendingBuildAdds } from "./sync-queue.js";
import { buildAddId, buildDeleteId } from "./outbox-state.js";
import { reloadOpenBuildTree, resolveBuildId } from "./build-entry.js";
import { postBuildAdds } from "./build-flush.js";

const rejectedAdd = (m, error) => ({
  kind: "add", tempId: m.tempId, uci: m.uci, message: error.message, status: error.status ?? null,
});

// ``error`` is what the flush's own request got back: the delete request's
// when deletes were still queued, else the add request's. ``owns`` is asked
// before every request and before anything goes back on the queue: once the
// queue is no longer this account's, nothing more is sent under the new session
// and nothing is put on the new account's queue.
export async function isolateRejectedBuildOps(batch, deleteBatch, repertoireId, error, since, owns = () => true) {
  const rejected = [];
  const settled = { build: [], deletes: [], train: [] };
  const idMap = {};
  let payload = null;
  let failure = deleteBatch.length ? null : error;
  const lostAccess = (err) => classifySyncError(err).kind === "forbidden";

  for (let i = 0; i < deleteBatch.length; i += 1) {
    const entry = deleteBatch[i];
    const id = resolveBuildId(entry);
    if (String(id).startsWith("tmp-")) {
      settled.deletes.push(buildDeleteId(entry)); // never reached the server
      continue;
    }
    if (!owns()) return { rejected, settled, idMap, payload };
    try {
      if (lostAccess(error)) throw error;
      payload = await postJson("/api/build/delete-nodes", { repertoire_id: repertoireId, since, node_ids: [id] });
      settled.deletes.push(buildDeleteId(entry));
    } catch (err) {
      if (classifySyncError(err).retriable) {
        // Sign-out/network blip mid-isolation: stop here and keep this delete
        // plus every later one queued for the next flush.
        // Another account's queue keeps none of these: they stay in this
        // account's durable outbox.
        if (owns()) buildState.buildPendingDeletes = deleteBatch.slice(i).concat(buildState.buildPendingDeletes);
        return { rejected, settled, idMap, payload };
      }
      settled.deletes.push(buildDeleteId(entry));
      rejected.push({ kind: "delete", id, message: err.message, status: err.status ?? null });
      if (lostAccess(err)) failure = err;
    }
  }

  let remaining = orderPendingBuildAdds(batch);
  const settle = (ops) => settled.build.push(...ops.map(buildAddId));
  while (remaining.length) {
    if (!failure) {
      try {
        payload = await postBuildAdds(repertoireId, remaining.map((m) => ({ ...m, parentRef: resolveBuildId(m.parentRef) })), since, { owns });
        if (payload?.unsent) return { rejected, settled, idMap: Object.assign(idMap, payload.id_map), payload };
        Object.assign(idMap, payload?.id_map || {});
        settle(remaining);
        break;
      } catch (err) {
        failure = err;
      }
    }
    const info = classifySyncError(failure);
    if (info.retriable) {
      if (owns()) buildState.buildPending = remaining.concat(buildState.buildPending);
      break;
    }
    if (info.kind === "forbidden") {
      rejected.push(...remaining.map((m) => rejectedAdd(m, failure)));
      settle(remaining);
      break;
    }
    const named = failure.detail?.temp_id;
    if (!remaining.some((m) => m.tempId === named)) {
      ({ payload } = await isolateEachAdd(remaining, repertoireId, since, owns, { rejected, settled, idMap, payload }));
      break;
    }
    // Drop the named move and every move played after it on its line (parents
    // come first in ``remaining``), then resend the rest together.
    const dropped = new Set([named]);
    for (const m of remaining) {
      if (dropped.has(m.parentRef)) dropped.add(m.tempId);
    }
    const gone = remaining.filter((m) => dropped.has(m.tempId));
    rejected.push(...gone.map((m) => rejectedAdd(m, failure)));
    settle(gone);
    remaining = remaining.filter((m) => !dropped.has(m.tempId));
    failure = null;
  }
  if (rejected.some((entry) => entry.status === 403)) {
    // This caller can no longer edit: the reloaded tree shows it read-only.
    await reloadOpenBuildTree();
  }
  return { rejected, settled, idMap, payload };
}

// The old way, for a refusal that names no move: each move alone.
async function isolateEachAdd(ordered, repertoireId, since, owns, result) {
  for (let i = 0; i < ordered.length; i += 1) {
    if (!owns()) break;
    const m = ordered[i];
    // A parent from this same isolation round now has a real id.
    const parentRef = result.idMap[m.parentRef] || resolveBuildId(m.parentRef);
    try {
      const reply = await postJson("/api/build/add-moves", {
        repertoire_id: repertoireId, since, moves: [{ tempId: m.tempId, parentRef, uci: m.uci }],
      });
      Object.assign(result.idMap, reply?.id_map || {});
      result.payload = reply || result.payload;
      result.settled.build.push(buildAddId(m));
    } catch (err) {
      if (classifySyncError(err).retriable) {
        if (owns()) buildState.buildPending = ordered.slice(i).concat(buildState.buildPending);
        break;
      }
      result.settled.build.push(buildAddId(m));
      result.rejected.push(rejectedAdd(m, err));
    }
  }
  return result;
}
