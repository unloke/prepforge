import { createEngineProvider, ANALYSIS_MAX_NODES } from "./stockfish-provider.js";

// Consumers own subscriptions, not workers. A board change releases its old
// subscription; another consumer (or a quick return) can still use that search.
export function createEvaluationSource({ createProvider = createEngineProvider, pollMs = 100, idleMs = 1500, cacheSize = 100 } = {}) {
  const jobs = new Map();
  let generation = 0;
  const keyOf = (fen, depth) => `${depth}|${fen}`;
  function stop(job) {
    clearInterval(job.timer);
    job.timer = null;
    if (job.provider) {
      const provider = job.provider;
      job.provider = null;
      Promise.resolve(provider.close()).catch(() => {});
    }
  }
  function capture(job) {
    if (!job.provider) return;
    const snapshot = job.provider.snapshot();
    if (snapshot?.fen !== job.fen) return;
    // Never replace a useful interrupted read with an empty startup frame.
    if (snapshot.pvs?.length || !job.snapshot?.pvs?.length) job.snapshot = snapshot;
    if (snapshot.error || snapshot.running === false && (snapshot.current_depth > 0 || snapshot.pvs?.length)) {
      job.complete = !snapshot.error;
      stop(job);
    }
  }
  function trim() {
    for (const [key, job] of jobs) {
      if (jobs.size <= cacheSize) break;
      if (!job.refs && !job.provider) jobs.delete(key);
    }
  }
  async function start(job, multipv) {
    const epoch = generation;
    stop(job);
    job.complete = false;
    if (multipv > job.multipv || job.snapshot?.error) job.snapshot = null;
    else if (job.snapshot) job.snapshot = { ...job.snapshot, running: true };
    job.multipv = multipv;
    const provider = createProvider({ maxDepth: job.depth, maxMultipv: 5, maxNodes: ANALYSIS_MAX_NODES });
    job.provider = provider;
    try {
      await provider.open({ fen: job.fen, multipv });
      if (epoch !== generation || provider !== job.provider) return;
      capture(job);
      if (job.provider) job.timer = setInterval(() => {
        capture(job);
        if (!job.refs && Date.now() - job.releasedAt >= idleMs) stop(job);
      }, pollMs);
    } catch (error) {
      if (epoch !== generation || provider !== job.provider) return;
      job.snapshot = { fen: job.fen, error: error.message, pvs: [], running: false };
      stop(job);
      throw error;
    }
  }
  function acquire(fen, depth, multipv = 1) {
    const key = keyOf(fen, depth);
    let job = jobs.get(key);
    if (!job) {
      job = { fen, depth, multipv: 0, refs: 0, snapshot: null, provider: null, timer: null, complete: false };
      jobs.set(key, job);
    }
    job.refs += 1;
    // Rapid navigation must not accumulate one 128 MB worker per abandoned ply.
    const active = [...jobs.values()].filter((entry) => entry.provider);
    for (const entry of active) {
      if (active.filter((item) => item.provider).length < 4) break;
      if (!entry.refs && entry !== job) { capture(entry); stop(entry); }
    }
    if (multipv > job.multipv || !job.provider && !job.complete) {
      job.ready = start(job, Math.max(multipv, job.multipv));
      // A caller may release while startup is pending; don't orphan a rejection.
      job.ready.catch(() => {});
    }
    trim();
    let released = false;
    return {
      ready: (async () => {
        let pending;
        do {
          pending = job.ready;
          await pending;
        } while (pending !== job.ready);
      })(),
      snapshot: () => { capture(job); return job.snapshot; },
      release: () => {
        if (released) return;
        released = true;
        capture(job);
        job.refs -= 1;
        job.releasedAt = Date.now();
      },
    };
  }
  return {
    // EngineProvider-compatible handle. close() only detaches this consumer.
    createHandle({ maxDepth = 16 } = {}) {
      let lease = null;
      let seq = 0;
      async function select({ fen, multipv = 1 }) {
        const token = ++seq;
        lease?.release();
        const next = acquire(fen, maxDepth, multipv);
        lease = next;
        await next.ready;
        return token === seq ? next.snapshot() : null;
      }
      return { open: select, update: select, snapshot: () => lease?.snapshot(), close: async () => { seq += 1; lease?.release(); lease = null; } };
    },
    publish(fen, depth, snapshot) {
      if (snapshot?.fen !== fen || !snapshot.pvs?.length) return;
      const key = keyOf(fen, depth);
      const old = jobs.get(key);
      if (old?.provider || (old?.snapshot?.current_depth || 0) > (snapshot.current_depth || 0)) return;
      if (old) {
        old.snapshot = snapshot;
        old.complete = true;
        old.multipv = snapshot.pvs.length;
      } else {
        jobs.set(key, { fen, depth, multipv: snapshot.pvs.length, refs: 0, snapshot, complete: true, provider: null });
      }
      trim();
    },
    clear() {
      generation += 1;
      for (const job of jobs.values()) stop(job);
      jobs.clear();
    },
  };
}
