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
// - a lightweight cross-tab lock keeps two open tabs from double-sending the
//   same queue (the server receipts are the hard guarantee; this avoids the
//   duplicate traffic and the confusing double toasts).
//
// Everything here is pure storage plumbing: no DOM, no network.

const KEY_PREFIX = "prepforge.outbox.v1.";
const LOCK_KEY = "prepforge.outbox.lock.v1";
const LOCK_STALE_MS = 30_000;

/** Outbox storage key for one owner ("" = not signed in yet). */
export function outboxKey(ownerId) {
  return KEY_PREFIX + (ownerId || "anon");
}

const EMPTY = {
  build: { pending: [], pendingDeletes: [], idMap: {}, rejected: [] },
  train: { pending: [], rejected: [] },
};

function safeParse(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      build: {
        pending: Array.isArray(parsed.build?.pending) ? parsed.build.pending : [],
        pendingDeletes: Array.isArray(parsed.build?.pendingDeletes)
          ? parsed.build.pendingDeletes
          : [],
        idMap: parsed.build?.idMap && typeof parsed.build.idMap === "object" ? parsed.build.idMap : {},
        // Permanently-rejected ops are KEPT for inspection/export — never
        // silently dropped (R-01/R-02).
        rejected: Array.isArray(parsed.build?.rejected) ? parsed.build.rejected : [],
      },
      train: {
        pending: Array.isArray(parsed.train?.pending) ? parsed.train.pending : [],
        rejected: Array.isArray(parsed.train?.rejected) ? parsed.train.rejected : [],
      },
    };
  } catch (_) {
    return null;
  }
}

/** Load the owner's outbox (shape-normalized), or an empty one. */
export function loadOutbox(ownerId) {
  try {
    return safeParse(localStorage.getItem(outboxKey(ownerId))) || {
      build: { pending: [], pendingDeletes: [], idMap: {}, rejected: [] },
      train: { pending: [], rejected: [] },
    };
  } catch (_) {
    return {
      build: { pending: [], pendingDeletes: [], idMap: {}, rejected: [] },
      train: { pending: [], rejected: [] },
    };
  }
}

/** Persist the owner's outbox. Called on every queue mutation and settle. */
export function saveOutbox(ownerId, state) {
  try {
    localStorage.setItem(outboxKey(ownerId), JSON.stringify(state));
    return true;
  } catch (_) {
    return false; // storage blocked: behaviour degrades to the old in-memory queue
  }
}

/** Drop the owner's outbox once everything is confirmed saved. */
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
