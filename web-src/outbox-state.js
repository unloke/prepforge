// The durable outbox's shape and its merge: pure functions shared by the sync
// queue (sync-queue.js) and the IndexedDB store (outbox-db.js), so neither has
// to import the other.

function emptyOutbox() {
  return {
    build: { pending: [], pendingDeletes: [], idMap: {} },
    train: { pending: [], rejected: [] },
    settled: { build: [], deletes: [], train: [] },
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// ----- operation identity ----------------------------------------------------
// Merge is per operation, so every entry needs a stable identity. Train
// attempts carry a server-side dedupe UUID; Build entries carry their tmp id
// (deletes are plain node ids, stringified so both shapes dedupe).

export function buildAddId(entry) {
  return String(entry?.tempId || "");
}

export function buildDeleteId(entry) {
  return String(entry?.id || "");
}

export function trainAttemptId(entry) {
  return String(entry?.attempt_uuid || "");
}

function rejectedId(entry) {
  try {
    return JSON.stringify(entry);
  } catch (_) {
    return "";
  }
}

function mergeById(base, incoming, idOf) {
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

// A suspended tab can retain a stale snapshot indefinitely. Do not evict
// tombstones until an enforced replay horizon exists.
// Rejected operations remain available until the user resolves them.
export function mergeOutboxState(stored, incoming, settled = null) {
  const base = stored || emptyOutbox();
  const next = incoming || emptyOutbox();
  const done = {
    build: new Set([...asArray(base.settled?.build), ...asArray(settled?.build)].map(String)),
    deletes: new Set([...asArray(base.settled?.deletes), ...asArray(settled?.deletes)].map(String)),
    train: new Set([...asArray(base.settled?.train), ...asArray(settled?.train)].map(String)),
  };
  for (const group of [...asArray(base.train.rejected), ...asArray(next.train?.rejected)]) {
    for (const attempt of asArray(group.attempts)) {
      done.train.add(trainAttemptId({ ...attempt, session_id: group.sessionId }));
    }
  }
  const keepBuild = (entry) => !done.build.has(buildAddId(entry));
  const keepDelete = (entry) => !done.deletes.has(buildDeleteId(entry));
  const keepTrain = (entry) => !done.train.has(trainAttemptId(entry));

  return {
    build: {
      pending: mergeById(
        asArray(base.build.pending).filter(keepBuild),
        asArray(next.build?.pending).filter(keepBuild),
        buildAddId,
      ),
      pendingDeletes: mergeById(
        asArray(base.build.pendingDeletes).filter(keepDelete),
        asArray(next.build?.pendingDeletes).filter(keepDelete),
        buildDeleteId,
      ),
      // tmp -> real ids are additive facts: a later flush's mapping always wins.
      idMap: { ...(base.build.idMap || {}), ...(next.build?.idMap || {}) },
    },
    train: {
      pending: mergeById(
        asArray(base.train.pending).filter(keepTrain),
        asArray(next.train?.pending).filter(keepTrain),
        trainAttemptId,
      ),
      rejected: mergeById(asArray(base.train.rejected), asArray(next.train?.rejected), rejectedId),
    },
    settled: {
      build: [...done.build],
      deletes: [...done.deletes],
      train: [...done.train],
    },
  };
}
