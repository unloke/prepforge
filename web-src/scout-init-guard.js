// Serializes Scout session initialization — prevents parallel initScoutState runs.

export function createScoutInitGuard() {
  let generation = 0;
  let initializing = false;

  return {
    get isInitializing() {
      return initializing;
    },
    get generation() {
      return generation;
    },
    tryBegin() {
      if (initializing) return null;
      initializing = true;
      return ++generation;
    },
    finish(token) {
      if (token === generation) initializing = false;
    },
    invalidate() {
      generation += 1;
      initializing = false;
    },
    isCurrent(token) {
      return token === generation;
    },
  };
}