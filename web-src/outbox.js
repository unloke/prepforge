// The durable, owner-scoped outbox behind local-first writes (R-03/R-04): a
// reload, crash or sign-out can't silently drop work the user already did, and
// operation identity survives, so a replay after a lost response is recognized
// server-side instead of double-counted.
//
// Each feature plugs in as a domain (controllers/build-sync.js,
// controllers/train-sync.js):
//
//   key           its slice of the stored outbox
//   merge         how that slice merges across tabs (build-outbox.js, ...)
//   snapshot()    its live queue as that slice
//   restore(s)    put a stored slice back on the live queue; returns a summary
//   state()       its queue's timer/flushing/retry fields
//   hasWork()     whether anything is waiting to be sent
//   pendingCount() how many operations are still unsent
//   idleMs        idle debounce before a flush
//   flush(checkpoint, owns)  send what is queued (see sync-queue.js)
//   attach({ queue, persist })  receives its queue and a persist that files
//                 the domain's settled identities under its own key
//
// This module owns only what is shared: one IndexedDB checkpoint holding every
// domain's slice, one cross-tab-locked queue per domain, restore after a reload
// or sign-in, and the drain before sign-out. It knows no feature, endpoint or
// state slice.

import { createSyncQueue } from "./sync-queue.js";
import { composeOutboxMerge } from "./outbox-state.js";

const outboxDatabase = () => import("./outbox-db.js");

export function createOutbox({ domains, owner, generation, tabId, onPersist }) {
  const merge = composeOutboxMerge(domains);
  const serialize = () => Object.fromEntries(domains.map((domain) => [domain.key, domain.snapshot()]));

  async function persist(settled = null) {
    const account = owner(), epoch = generation();
    let ok = false;
    try {
      // Capture before loading the storage chunk or draining live queues.
      const snapshot = structuredClone(serialize()), done = structuredClone(settled);
      await (await outboxDatabase()).saveDurableOutbox(account, snapshot, done, merge);
      ok = true;
    } catch (error) { console.warn("Outbox persistence failed", error); }
    if (account === owner() && epoch === generation()) onPersist?.(ok);
    return ok;
  }

  const queues = domains.map((domain) => {
    const queue = createSyncQueue({ key: domain.key, state: domain.state, owner, generation, tabId,
      hasWork: domain.hasWork, idleMs: domain.idleMs, flush: domain.flush, persist });
    domain.attach({ queue, persist: (settled = null) => persist(settled === null ? null : { [domain.key]: settled }) });
    return queue;
  });

  // This owner's stored outbox goes back on the live queues: each domain gets
  // its own slice. Null when the owner changed while it loaded.
  async function restore() {
    const account = owner(), epoch = generation();
    const stored = await load(account);
    if (account !== owner() || epoch !== generation()) return null;
    return Object.fromEntries(domains.map((domain) => [domain.key, domain.restore(stored[domain.key])]));
  }

  // Before sign-out: checkpoint, then send whatever each queue can send.
  async function drain() {
    // A flush in flight holds its batch outside the queue, so the queue can
    // look empty while its request is still out. Wait for every one, whether
    // it started before the drain or while the drain checkpointed; one that
    // failed has put its batch back, which then counts as unsent.
    const before = domains.map((domain) => domain.state().flushing);
    await persist();
    for (const queue of queues) queue.cancel();
    await Promise.all(domains.map(async (domain, index) => {
      if (before[index] && !(await before[index].catch(() => false))) return;
      for (;;) {
        const running = domain.state().flushing;
        if (running) {
          if (!(await running.catch(() => false))) return;
          continue;
        }
        // A flush may cover only part of a queue (Build sends one repertoire
        // at a time): keep going while each one saves.
        if (!domain.hasWork()) return;
        if (!(await queues[index].flush().catch(() => false))) return;
      }
    }));
    await persist();
    return { pending: domains.reduce((total, domain) => total + domain.pendingCount(), 0) };
  }

  function load(account = owner()) {
    return outboxDatabase().then((db) => db.loadDurableOutbox(account, merge));
  }

  return { persist, restore, drain, load };
}
