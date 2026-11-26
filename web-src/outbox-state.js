// The durable outbox's merge, without any feature in it. Each feature owns one
// slice of an owner's stored outbox (build-outbox.js, train-outbox.js): its
// queued operations, their identities and the tombstones of settled ones. A
// save merges every slice with that slice's own rules, inside one IndexedDB
// transaction (outbox-db.js), so concurrent tabs never lose each other's ops.

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// Merge is per operation: an entry whose identity is already present stays
// where it was; entries without an identity are always kept.
export function mergeById(base, incoming, idOf) {
  const out = [];
  const seen = new Set();
  for (const entry of base) {
    const id = idOf(entry);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(entry);
  }
  for (const entry of incoming) {
    const id = idOf(entry);
    if (!id || !seen.has(id)) {
      if (id) seen.add(id);
      out.push(entry);
    }
  }
  return out;
}

// Settled identities only ever accumulate. A suspended tab can retain a stale
// snapshot indefinitely, so tombstones are not evicted until an enforced
// replay horizon exists.
export function tombstones(...lists) {
  return new Set(lists.flatMap(asArray).map(String));
}

// One merge for a whole stored outbox from each domain's ``{ key, merge }``.
// ``settled`` carries each domain's newly confirmed identities under its key.
export function composeOutboxMerge(domains) {
  return (stored, incoming, settled = null) => Object.fromEntries(domains.map(({ key, merge }) =>
    [key, merge(stored?.[key] ?? null, incoming?.[key] ?? null, settled?.[key] ?? null)]));
}
