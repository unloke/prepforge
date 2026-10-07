import { classifySyncError } from "./sync-errors.js";

// Transport-independent lifecycle; flush snapshots synchronously, then awaits
// the durable checkpoint before sending. Payload/reconcile policy stays local.
export function createSyncQueue({ key, state, owner, generation, serialize, flush,
  hasWork, idleMs, persist, onPersist, tabId }) {
  persist ??= checkpoint;
  async function checkpoint(settled = null) {
    const account = owner(), epoch = generation();
    // Capture before loading the storage chunk or draining live queues.
    let ok = false;
    try {
      const snapshot = structuredClone(serialize()), done = structuredClone(settled);
      await (await outboxDatabase()).saveDurableOutbox(account, snapshot, done);
      ok = true;
    }
    catch (error) { console.warn("Outbox persistence failed", error); }
    if (account === owner() && epoch === generation()) onPersist?.(ok);
    return ok;
  }
  function cancel() {
    const sync = state();
    clearTimeout(sync.timer);
    sync.timer = null;
  }
  function arm(delay) {
    cancel();
    const sync = state();
    sync.timer = setTimeout(() => { sync.timer = null; drain(); }, delay);
  }
  function schedule() { void persist(); arm(idleMs); }
  function retry(info) {
    const sync = state();
    sync.retry = Math.min(sync.retry + 1, 6);
    arm(info?.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** (sync.retry - 1)));
  }
  function drain() {
    const sync = state(), account = owner(), epoch = generation();
    if (sync.flushing) return sync.flushing;
    if (!hasWork()) return Promise.resolve(true);
    const lockId = `${tabId}:${account}:${epoch}`;
    if (!acquireFlushLock(account, lockId, Date.now(), key)) { arm(idleMs); return Promise.resolve(false); }
    cancel();
    const checkpoint = persist();
    const isCurrent = () => account === owner() && epoch === generation() && sync === state();
    const task = Promise.resolve(flush(checkpoint, isCurrent)).finally(() => {
      if (sync.flushing === task) sync.flushing = null;
      releaseFlushLock(lockId, key);
    });
    sync.flushing = task;
    return task;
  }
  return { schedule, retry, cancel, persist, flush: drain,
    resetRetry() { state().retry = 0; },
  };
}

/** Bound the entire request, including CSRF bootstrap and response body reads. */
export async function withRequestDeadline(run, { signal, timeoutMs = 30_000, method = "GET" } = {}) {
  if (signal?.aborted) throw signal.reason;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(method === "GET" ? "Request timed out — try again" : "Save timed out; result unconfirmed — keep your unsaved work");
    error.name = "RequestTimeoutError";
    error.resultUnconfirmed = method !== "GET";
    controller.abort(error);
  }, timeoutMs);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

const outboxDatabase = () => import("./outbox-db.js");
export const loadDurableOutbox = async (owner) => (await outboxDatabase()).loadDurableOutbox(owner);
export const clearDurableOutbox = async (owner) => (await outboxDatabase()).clearDurableOutbox(owner);

const LOCK_KEY = "prepforge.outbox.lock.v1";
const LOCK_STALE_MS = 30_000;
// A suspended tab can retain a stale snapshot indefinitely. Do not evict
// tombstones until an enforced replay horizon exists.
// Rejected operations remain available until the user resolves them.

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
    if (id && seen.has(id) && Number.isInteger(entry.base_revision)) {
      const index = out.findIndex((stored) => idOf(stored) === id);
      if (!Number.isInteger(out[index].base_revision) || entry.base_revision > out[index].base_revision) {
        out[index] = entry;
      }
    }
    if (!id || !seen.has(id)) {
      if (id) seen.add(id);
      out.push(entry);
    }
  }
  return out;
}

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
      rejected: mergeById(asArray(base.build.rejected), asArray(next.build?.rejected), rejectedId),
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

export function outboxHasWork(state) {
  return !!(
    state &&
    ((state.build.pending && state.build.pending.length) ||
      (state.build.pendingDeletes && state.build.pendingDeletes.length) ||
      (state.train.pending && state.train.pending.length))
  );
}

export function outboxHasRejected(state) {
  return !!(
    state &&
    ((state.build.rejected && state.build.rejected.length) ||
      (state.train.rejected && state.train.rejected.length))
  );
}

export function outboxIsQuiescent(state) {
  return !outboxHasWork(state) && !outboxHasRejected(state);
}

export function acquireFlushLock(ownerId, tabId, now = Date.now(), key = "build") {
  const lockKey = `${LOCK_KEY}.${key}`;
  try {
    const raw = localStorage.getItem(lockKey);
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
      lockKey,
      JSON.stringify({ ownerId: ownerId || "anon", tabId, at: now }),
    );
    return true;
  } catch (_) {
    return true; // storage blocked: no lock, rely on server-side receipts
  }
}

export function releaseFlushLock(tabId, key = "build") {
  const lockKey = `${LOCK_KEY}.${key}`;
  try {
    const raw = localStorage.getItem(lockKey);
    if (!raw) return;
    const lock = JSON.parse(raw);
    if (lock && lock.tabId === tabId) localStorage.removeItem(lockKey);
  } catch (_) {
    /* ignore */
  }
}
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

export function groupAttempts(pending, currentSessionId, currentGeneration) {
  const bySession = new Map();
  const key = (id, generation) => JSON.stringify([id, generation ?? null]);
  for (const item of pending) {
    const k = key(item.session_id, item.session_generation);
    if (!bySession.has(k)) bySession.set(k, [item.session_id, []]);
    bySession.get(k)[1].push({ node_id: item.node_id, correct: item.correct, attempt_uuid: item.attempt_uuid,
      ...(item.session_generation != null ? { session_generation: item.session_generation } : {}) });
  }
  const currentKey = key(currentSessionId, currentGeneration);
  if (currentSessionId && !bySession.has(currentKey)) bySession.set(currentKey, [currentSessionId, []]);
  return [...bySession.values()];
}

export function isRetriableSyncError(error) {
  return classifySyncError(error).retriable;
}

export async function flushGroups(groups, postGroup) {
  const rejectedGroups = [];
  for (let i = 0; i < groups.length; i++) {
    const [sessionId, attempts] = groups[i];
    try {
      await postGroup(sessionId, attempts);
    } catch (error) {
      if (isRetriableSyncError(error)) {
        return { retriable: true, failedGroups: groups.slice(i), rejectedGroups };
      }
      rejectedGroups.push({ sessionId, attempts, status: error && error.status });
    }
  }
  return { retriable: false, failedGroups: [], rejectedGroups };
}

export function ungroupAttempts(groups) {
  const flat = [];
  for (const [sessionId, attempts] of groups) {
    for (const a of attempts) {
      flat.push({ session_id: sessionId, node_id: a.node_id, correct: a.correct, attempt_uuid: a.attempt_uuid,
        ...(a.session_generation != null ? { session_generation: a.session_generation } : {}) });
    }
  }
  return flat;
}
