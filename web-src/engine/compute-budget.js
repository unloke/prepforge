// Worker-lifetime budget shared by every browser Stockfish consumer.
export function createComputeBudget({ limit = 4, backgroundLimit = 3,
  scheduleIdle = fn => globalThis.requestIdleCallback ? requestIdleCallback(fn) : setTimeout(fn, 100),
  cancelIdle = id => globalThis.cancelIdleCallback ? cancelIdleCallback(id) : clearTimeout(id),
} = {}) {
  let used = 0, background = 0;
  const queue = [];
  const idle = new Set();
  const allocations = new Set();
  let batches = 0;
  let sessions = 0, probe = null, idleTask = null;
  const probes = [];
  function demand() { probe?.onDemand?.(); }
  function drainProbe() {
    if (!probes.length || probe || sessions || batches || queue.length) return;
    // Only warm, unused workers may be reclaimed for a probe.
    for (const reclaim of [...idle]) { idle.delete(reclaim); reclaim(); }
    if (used || idleTask !== null) return;
    idleTask = scheduleIdle(() => {
      idleTask = null;
      if (used || sessions || batches || queue.length || probe || !probes.length) return;
      const entry = probes.shift();
      entry.cleanup();
      probe = entry;
      entry.resolve(() => { if (probe === entry) { probe = null; drainProbe(); } });
    });
  }
  function reclaimIdle() {
    if (!queue.length) return;
    const reclaim = idle.values().next().value;
    if (reclaim) {
      idle.delete(reclaim);
      reclaim();
    }
  }
  function drain() {
    queue.sort((a, b) => Number(b.interactive) - Number(a.interactive));
    while (used < limit) {
      const i = queue.findIndex((entry) => (!batches || entry.batch) && (entry.interactive || background < backgroundLimit));
      if (i < 0) { reclaimIdle(); drainProbe(); return; }
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
    drainProbe();
  }
  function acquire({ interactive = false, signal, batch = false, reclaim } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException("Engine allocation stopped", "AbortError"));
    demand();
    return new Promise((resolve, reject) => {
      const abort = () => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        entry.cleanup();
        reject(new DOMException("Engine allocation stopped", "AbortError"));
        drainProbe();
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
    drainProbe();
    return () => idle.delete(reclaim);
  }
  function beginBatch() {
    batches++;
    demand();
    for (const entry of [...allocations]) if (!entry.batch) entry.reclaim?.();
    for (const reclaim of [...idle]) reclaim();
    let ended = false;
    return () => { if (!ended) { ended = true; batches--; drain(); } };
  }
  return {
    acquire, registerIdle,
    configure(workers) { limit = backgroundLimit = workers; drain(); },
    beginSession() {
      sessions++;
      // Maia follow-ups and save/render still belong to the whole-game run.
      // Reopening live engines between its batches defeats the phone's one-worker
      // follow-up limit and leaves a full heap resident during persistence.
      const endBatch = beginBatch();
      let ended = false;
      return () => { if (!ended) { ended = true; sessions--; endBatch(); } };
    },
    acquireProbe({ signal, onDemand } = {}) {
      if (signal?.aborted) return Promise.reject(new DOMException("Detection stopped", "AbortError"));
      return new Promise((resolve, reject) => {
        const abort = () => {
          const i = probes.indexOf(entry);
          if (i >= 0) probes.splice(i, 1);
          entry.cleanup();
          if (!probes.length && idleTask !== null) { cancelIdle(idleTask); idleTask = null; }
          reject(new DOMException("Detection stopped", "AbortError"));
        };
        const entry = { resolve, onDemand, cleanup: () => signal?.removeEventListener("abort", abort) };
        signal?.addEventListener("abort", abort, { once: true });
        probes.push(entry);
        drainProbe();
      });
    },
    beginBatch,
    snapshot: () => ({ used, background, queued: queue.length, limit, backgroundLimit }),
  };
}

export const stockfishBudget = createComputeBudget({ limit: 1, backgroundLimit: 1 });
