// Build's slice of the durable outbox: queued adds (identified by their
// tab-unique temp id), queued deletes (by node id), the tmp -> real id map,
// and tombstones for settled adds and deletes. Settling is ``{ adds, deletes }``.
// Rejected Build edits are reported once and dropped, so none are stored.

import { asArray, mergeById, tombstones } from "./outbox-state.js";

export function buildAddId(entry) {
  return String(entry?.tempId || "");
}

export function buildDeleteId(entry) {
  return String(entry?.id || "");
}

function mergeBuildOutbox(stored, incoming, settled) {
  const base = stored || {};
  const next = incoming || {};
  const adds = tombstones(base.settled?.adds, settled?.adds);
  const deletes = tombstones(base.settled?.deletes, settled?.deletes);
  const keepAdd = (entry) => !adds.has(buildAddId(entry));
  const keepDelete = (entry) => !deletes.has(buildDeleteId(entry));
  return {
    pending: mergeById(asArray(base.pending).filter(keepAdd), asArray(next.pending).filter(keepAdd), buildAddId),
    pendingDeletes: mergeById(
      asArray(base.pendingDeletes).filter(keepDelete),
      asArray(next.pendingDeletes).filter(keepDelete),
      buildDeleteId,
    ),
    // tmp -> real ids are additive facts: a later flush's mapping always wins.
    idMap: { ...(base.idMap || {}), ...(next.idMap || {}) },
    settled: { adds: [...adds], deletes: [...deletes] },
  };
}

export const buildOutbox = { key: "build", merge: mergeBuildOutbox };

// Parents before children, however the queue was assembled: a move whose
// parent is another queued move can only be sent once that parent has its real id.
export function orderPendingBuildAdds(entries) {
  let remaining = Array.isArray(entries) ? entries.slice() : [];
  const ordered = [];
  while (remaining.length) {
    const waiting = new Set(
      remaining.map((entry) => entry && entry.tempId).filter(Boolean),
    );
    const ready = [];
    const rest = [];
    for (const entry of remaining) {
      const parentRef = entry && entry.parentRef;
      if (parentRef && parentRef !== entry.tempId && waiting.has(parentRef)) {
        rest.push(entry);
      } else {
        ready.push(entry);
      }
    }
    if (!ready.length) {
      ordered.push(...rest); // unresolvable chain: keep it, let the server judge
      break;
    }
    ordered.push(...ready);
    remaining = rest;
  }
  return ordered;
}
