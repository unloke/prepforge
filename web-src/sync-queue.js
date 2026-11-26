// One local-first queue's lifecycle, with no feature or storage in it: idle
// debounce, backoff, one in-flight flush, and a cross-tab lease so two tabs
// never send the same owner's queue. A flush snapshots synchronously, then
// awaits ``persist`` (the durable checkpoint, outbox.js) before sending.
// Payload and reconcile policy stay with the feature's ``flush``.
export function createSyncQueue({ key, state, owner, generation, flush, hasWork, idleMs, persist, tabId }) {
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
  let heldLock = null;
  let pageHidden = false;
  globalThis.addEventListener?.("pagehide", () => {
    pageHidden = true;
    if (heldLock) releaseFlushLock(heldLock, key);
  });
  globalThis.addEventListener?.("pageshow", () => { pageHidden = false; });
  function drain() {
    // A late visibilitychange must not reacquire a lock after pagehide.
    if (pageHidden) return Promise.resolve(false);
    const sync = state(), account = owner(), epoch = generation();
    if (sync.flushing) return sync.flushing;
    if (!hasWork()) return Promise.resolve(true);
    const lockId = `${tabId}:${account}:${epoch}`;
    if (!acquireFlushLock(account, lockId, Date.now(), key)) { arm(idleMs); return Promise.resolve(false); }
    heldLock = lockId;
    // Keep the lease alive while the flush runs: a slow request must not look
    // like a dead tab and let a second tab send the same queue.
    const heartbeat = setInterval(() => refreshFlushLock(lockId, key), LOCK_HEARTBEAT_MS);
    cancel();
    const checkpoint = persist();
    const isCurrent = () => account === owner() && epoch === generation() && sync === state();
    const task = Promise.resolve(flush(checkpoint, isCurrent)).finally(() => {
      clearInterval(heartbeat);
      if (sync.flushing === task) sync.flushing = null;
      if (heldLock === lockId) heldLock = null;
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

const LOCK_KEY = "prepforge.outbox.lock.v1";
// The cross-tab lock is a lease: the holder renews it while it works, so a
// second tab waits its turn instead of sending the same queue twice. A holder
// that died without releasing (a crash, a force-quit) lets the lease run out
// in seconds — a dead tab must not block the next load of the same owner.
const LOCK_LEASE_MS = 8_000;
const LOCK_HEARTBEAT_MS = 2_000;
export function acquireFlushLock(ownerId, tabId, now, key) {
  const lockKey = `${LOCK_KEY}.${key}`;
  try {
    const raw = localStorage.getItem(lockKey);
    if (raw) {
      const lock = JSON.parse(raw);
      if (
        lock &&
        lock.tabId !== tabId &&
        lock.ownerId === (ownerId || "anon") &&
        now - (lock.at || 0) < LOCK_LEASE_MS
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

// Renews the holder's lease. A lock that is not ours any more (another tab
// took it over) is left alone.
export function refreshFlushLock(tabId, key, now = Date.now()) {
  const lockKey = `${LOCK_KEY}.${key}`;
  try {
    const raw = localStorage.getItem(lockKey);
    if (!raw) return false;
    const lock = JSON.parse(raw);
    if (!lock || lock.tabId !== tabId) return false;
    localStorage.setItem(lockKey, JSON.stringify({ ...lock, at: now }));
    return true;
  } catch (_) {
    return false; // storage blocked: the lock is advisory anyway
  }
}

export function releaseFlushLock(tabId, key) {
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
