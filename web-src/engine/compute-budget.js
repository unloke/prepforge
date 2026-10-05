// Worker-lifetime budget shared by every browser Stockfish consumer.
// Reserve one slot for the live board; queued interactive work goes first.
export function createComputeBudget({ limit = 4, backgroundLimit = 3 } = {}) {
  let used = 0, background = 0;
  const queue = [];
  const idle = new Set();
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
      const i = queue.findIndex((entry) => entry.interactive || background < backgroundLimit);
      if (i < 0) { reclaimIdle(); return; }
      const entry = queue.splice(i, 1)[0];
      entry.cleanup();
      used++;
      if (!entry.interactive) background++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        used--;
        if (!entry.interactive) background--;
        drain();
      });
    }
    reclaimIdle();
  }
  function acquire({ interactive = false, signal } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException("Engine allocation stopped", "AbortError"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        entry.cleanup();
        reject(new DOMException("Engine allocation stopped", "AbortError"));
      };
      const entry = { interactive, resolve, cleanup: () => signal?.removeEventListener("abort", abort) };
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
  return { acquire, registerIdle, snapshot: () => ({ used, background, queued: queue.length, limit, backgroundLimit }) };
}

export const stockfishBudget = createComputeBudget();
