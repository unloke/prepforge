import { engineProfile, subscribeEngineProfile } from "./engine-profile.js";

// Worker-lifetime budget shared by every browser Stockfish consumer.
export function createComputeBudget({ limit = 4, backgroundLimit = 3 } = {}) {
  let used = 0, background = 0;
  const queue = [];
  const idle = new Set();
  const allocations = new Set();
  let batches = 0;
  let paused = 0;
  function reclaimIdle() {
    if (!queue.length) return;
    const reclaim = idle.values().next().value;
    if (reclaim) {
      idle.delete(reclaim);
      reclaim();
    }
  }
  function drain() {
    if (paused) return;
    queue.sort((a, b) => Number(b.interactive) - Number(a.interactive));
    while (used < limit) {
      const i = queue.findIndex((entry) => (!batches || entry.batch) && (entry.interactive || background < backgroundLimit));
      if (i < 0) { reclaimIdle(); return; }
      const entry = queue.splice(i, 1)[0];
      entry.cleanup();
      used++;
      if (!entry.interactive) background++;
      allocations.add(entry);
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        allocations.delete(entry);
        used--;
        if (!entry.interactive) background--;
        drain();
      });
    }
    reclaimIdle();
  }
  function acquire({ interactive = false, signal, batch = false, reclaim } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException("Engine allocation stopped", "AbortError"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        entry.cleanup();
        reject(new DOMException("Engine allocation stopped", "AbortError"));
      };
      const entry = { interactive, batch, reclaim, resolve, cleanup: () => signal?.removeEventListener("abort", abort) };
      signal?.addEventListener("abort", abort, { once: true });
      queue.push(entry);
      drain();
    });
  }
  function registerIdle(reclaim) {
    idle.add(reclaim);
    reclaimIdle();
    return () => idle.delete(reclaim);
  }
  return {
    acquire, registerIdle,
    configure(workers) { limit = backgroundLimit = workers; drain(); },
    suspend() {
      paused++;
      for (const entry of [...allocations]) entry.reclaim?.();
      for (const reclaim of [...idle]) reclaim();
      return () => { paused--; drain(); };
    },
    beginBatch() {
      batches++;
      for (const entry of [...allocations]) if (!entry.batch) entry.reclaim?.();
      for (const reclaim of [...idle]) reclaim();
      let ended = false;
      return () => { if (!ended) { ended = true; batches--; drain(); } };
    },
    snapshot: () => ({ used, background, queued: queue.length, limit, backgroundLimit }),
  };
}

export const stockfishBudget = createComputeBudget({ limit: engineProfile().workers, backgroundLimit: engineProfile().workers });
subscribeEngineProfile(p => stockfishBudget.configure(p.workers));
