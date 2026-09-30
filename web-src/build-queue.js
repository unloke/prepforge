// Pure helpers for the Build flush queue (R-05).
//
// When a batch is refused as a whole, app.js isolates it by replaying one op
// at a time. Order matters there: a move whose parent is another move from the
// SAME batch needs that parent's real id, which only exists after the parent
// request lands. Replaying in queue order happens to work today, but any
// requeue (a retriable failure re-prepends the batch) can invert it — and one
// invalid sibling must never take a legal chain down with it.

/**
 * Stable parent-before-child ordering of queued adds.
 *
 * An entry is ready when its `parentRef` is not another entry still waiting in
 * the same pass. Each pass emits every ready entry in its original relative
 * order, so the result is deterministic; anything left after the passes (a
 * cycle, which the server rejects anyway) is appended in queue order rather
 * than dropped.
 *
 * @param {Array<{tempId: string, parentRef: string}>} entries
 * @returns {Array<object>} a new array; inputs are not mutated
 */
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