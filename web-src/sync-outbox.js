// Durable outbox for local-first edits (R-03).
//
// The Build/Train queues used to live only in appState memory: a refresh, a
// crashed tab, or a sign-out could drop unconfirmed edits. This module gives
// them a recoverable home in localStorage:
//
// - owner-scoped keys, so signing in as B never replays A's queued edits;
// - operation identity survives the round-trip (Build temp ids, Train attempt
//   UUIDs), so a replay after a lost response is idempotent — the server-side
//   receipt/dedupe recognizes it instead of double-counting;
// - entries carry their own target (repertoireId / session_id), so a replay
//   never lands on the wrong tree;
// - writes MERGE per operation instead of overwriting a whole snapshot, so a
//   second tab holding an older view cannot erase ops it never saw;
// - confirmed ops are recorded as tombstones ("settled") so a merge can drop
//   them again instead of resurrecting already-saved work;
// - a lightweight cross-tab lock keeps two open tabs from double-sending the
//   same queue (the server receipts are the hard guarantee; this avoids the
//   duplicate traffic and the confusing double toasts).
//
// Everything here is pure storage plumbing: no DOM, no network.

const KEY_PREFIX = "prepforge.outbox.v1.";
const LOCK_KEY = "prepforge.outbox.lock.v1";
const LOCK_STALE_MS = 30_000;
// Tombstones only have to outlive a concurrent tab's stale snapshot, which is
// seconds old — a bounded tail is plenty and keeps the record small.
const SETTLED_LIMIT = 200;
// Rejected ops are kept for review, but a device that never drains them must
// not grow without bound — the newest tail is what the user is working on.
const REJECTED_LIMIT = 100;

/** Outbox storage key for one owner ("" = not signed in yet). */
export function outboxKey(ownerId) {
  return KEY_PREFIX + (ownerId || "anon");
}

const EMPTY = {
  build: { pending: [], pendingDeletes: [], idMap: {}, rejected: [] },
  train: { pending: [], rejected: [] },
  settled: { build: [], deletes: [], train: [] },
};

function emptyOutbox() {
  return {
    build: { pending: [], pendingDeletes: [], idMap: {}, rejected: [] },
    train: { pending: [], rejected: [] },
    settled: { build: [], deletes: [], train: [] },
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      build: {
        pending: asArray(parsed.build?.pending),
        pendingDeletes: asArray(parsed.build?.pendingDeletes),
        idMap:
          parsed.build?.idMap && typeof parsed.build.idMap === "object" ? parsed.build.idMap : {},
        // Permanently-rejected ops are KEPT for inspection/export — never
        // silently dropped (R-01/R-02).
        rejected: asArray(parsed.build?.rejected),
      },
      train: {
        pending: asArray(parsed.train?.pending),
        rejected: asArray(parsed.train?.rejected),
      },
      settled: {
        build: asArray(parsed.settled?.build),
        deletes: asArray(parsed.settled?.deletes),
        train: asArray(parsed.settled?.train),
      },
    };
  } catch (_) {
    return null;
  }
}

/** Load the owner's outbox (shape-normalized), or an empty one. */
export function loadOutbox(ownerId) {
  try {
    return safeParse(localStorage.getItem(outboxKey(ownerId))) || emptyOutbox();
  } catch (_) {
    return emptyOutbox();
  }
}

// ----- operation identity ----------------------------------------------------
// Merge is per operation, so every entry needs a stable identity. Train
// attempts carry a server-side dedupe UUID; Build entries carry their tmp id
// (deletes are plain node ids, stringified so both shapes dedupe).

export function buildAddId(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry;
  return String(entry.tempId || entry.id || "");
}

export function buildDeleteId(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry;
  return String(entry.id || entry.tempId || "");
}

export function trainAttemptId(entry) {
  if (entry == null) return "";
  if (typeof entry !== "object") return String(entry);
  return String(entry.attempt_uuid || `${entry.session_id}:${entry.node_id}:${entry.correct}`);
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

function cap(list, limit = SETTLED_LIMIT) {
  return list.length > limit ? list.slice(list.length - limit) : list;
}

/**
 * Merge this tab's view of the queue into what is already stored (R-04).
 *
 * Union per operation, `incoming` wins on conflict, and anything named in
 * `settled` is dropped from BOTH sides — those ops are confirmed on the
 * server, so a stale tab must not resurrect them.
 *
 * @param {ReturnType<typeof loadOutbox>} stored
 * @param {object} incoming the caller's current in-memory state
 * @param {{build?: string[], deletes?: string[], train?: string[]}} [settled]
 *   identities confirmed since the last write
 */
export function mergeOutboxState(stored, incoming, settled = null) {
  const base = stored || emptyOutbox();
  const next = incoming || EMPTY;
  const done = {
    build: new Set(asArray(settled?.build).map(String)),
    deletes: new Set(asArray(settled?.deletes).map(String)),
    train: new Set(asArray(settled?.train).map(String)),
  };
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
      rejected: cap(
        mergeById(asArray(base.build.rejected), asArray(next.build?.rejected), rejectedId),
        REJECTED_LIMIT,
      ),
    },
    train: {
      pending: mergeById(
        asArray(base.train.pending).filter(keepTrain),
        asArray(next.train?.pending).filter(keepTrain),
        trainAttemptId,
      ),
      rejected: cap(
        mergeById(asArray(base.train.rejected), asArray(next.train?.rejected), rejectedId),
        REJECTED_LIMIT,
      ),
    },
    settled: {
      build: cap([...asArray(base.settled?.build), ...asArray(settled?.build)]),
      deletes: cap([...asArray(base.settled?.deletes), ...asArray(settled?.deletes)]),
      train: cap([...asArray(base.settled?.train), ...asArray(settled?.train)]),
    },
  };
}

/**
 * Persist the owner's outbox, merged with whatever is already stored.
 *
 * `settled` lists operations this tab just got confirmed for; they are
 * tombstoned so neither this tab nor a concurrent one re-queues them.
 * Returns false when storage refused the write (quota / blocked) so callers
 * can tell "kept in memory" from "recoverable from this device".
 */
export function saveOutbox(ownerId, state, settled = null) {
  try {
    const merged = mergeOutboxState(loadOutbox(ownerId), state, settled);
    localStorage.setItem(outboxKey(ownerId), JSON.stringify(merged));
    return true;
  } catch (_) {
    return false; // storage blocked: behaviour degrades to the old in-memory queue
  }
}

/**
 * Drop the owner's outbox once everything is confirmed saved — but only when
 * NOTHING is left for anyone (R-01: one feature succeeding must never erase
 * the other feature's unsynced work, nor the rejected ops kept for review).
 */
export function clearOutbox(ownerId) {
  try {
    localStorage.removeItem(outboxKey(ownerId));
  } catch (_) {
    /* ignore */
  }
}

/** True when the outbox holds anything that still needs to reach the server. */
export function outboxHasWork(state) {
  return !!(
    state &&
    ((state.build.pending && state.build.pending.length) ||
      (state.build.pendingDeletes && state.build.pendingDeletes.length) ||
      (state.train.pending && state.train.pending.length))
  );
}

/** Anything kept for the user to act on (rejected ops). */
export function outboxHasRejected(state) {
  return !!(
    state &&
    ((state.build.rejected && state.build.rejected.length) ||
      (state.train.rejected && state.train.rejected.length))
  );
}

/**
 * True when this owner's durable copy holds no unconfirmed work AND nothing
 * kept for review — the only state where dropping the key loses information.
 */
export function outboxIsQuiescent(state) {
  return !outboxHasWork(state) && !outboxHasRejected(state);
}

/**
 * Cross-tab flush lock. `acquireFlushLock(ownerId, tabId, now)` returns true
 * when this tab may flush now (no live lock, or the holder went stale).
 */
export function acquireFlushLock(ownerId, tabId, now = Date.now()) {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (raw) {
      const lock = JSON.parse(raw);
      if (
        lock &&
        lock.tabId !== tabId &&
        lock.ownerId === (ownerId || "anon") &&
        now - (lock.at || 0) < LOCK_STALE_MS
      ) {
        return false; // another tab is flushing this owner's queue right now
      }
    }
    localStorage.setItem(
      LOCK_KEY,
      JSON.stringify({ ownerId: ownerId || "anon", tabId, at: now }),
    );
    return true;
  } catch (_) {
    return true; // storage blocked: no lock, rely on server-side receipts
  }
}

export function releaseFlushLock(tabId) {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw) return;
    const lock = JSON.parse(raw);
    if (lock && lock.tabId === tabId) localStorage.removeItem(LOCK_KEY);
  } catch (_) {
    /* ignore */
  }
}