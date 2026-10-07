// One timer and one running task per stage. Superseded reads may finish, but
// their generation cannot publish; the latest scheduled read runs afterwards.
export function createEnrichPipeline({ debounceMs, run }) {
  let generation = 0, timer = null, active = null, ready = false, busy = false;
  function cancel() {
    clearTimeout(timer);
    timer = null;
    ready = false;
    generation += 1;
    busy = false;
  }
  function drain() {
    if (!ready || active) return;
    ready = false;
    const gen = generation;
    busy = true;
    const result = run(gen);
    if (!result?.then) { busy = false; return; }
    active = Promise.resolve(result).finally(() => {
      active = null;
      if (gen === generation) busy = false;
      drain();
    });
  }
  return {
    get generation() { return generation; },
    get inFlight() { return busy; },
    cancel,
    settled(gen) { if (gen === generation) busy = false; },
    schedule(coalesce = false) {
      if (coalesce && timer !== null) return;
      cancel();
      timer = setTimeout(() => { timer = null; ready = true; drain(); },
        typeof debounceMs === "function" ? debounceMs() : debounceMs);
    },
    flush() { cancel(); ready = true; drain(); },
  };
}
