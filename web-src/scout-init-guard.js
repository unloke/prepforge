// Serializes Scout session initialization — prevents parallel initScoutState runs.

/**
 * What a new Start may reuse from a previous same-username session.
 * Deep-scan and explorer rows are bound to the previous game set; a new Start
 * rebuilds games from newest, so those must not leak into the next report.
 * Maia / Stockfish leaf caches are FEN-keyed and safe to keep.
 */
export function scoutStateCarryover(prevState, username) {
  const sameUser = prevState?.username === username;
  return {
    activeSpeed: sameUser ? prevState.activeSpeed : "all",
    ecoCache: sameUser ? prevState.ecoCache || new Map() : new Map(),
    maiaResults: sameUser ? prevState.maiaResults || new Map() : new Map(),
    maiaCache: sameUser ? prevState.maiaCache || new Map() : new Map(),
    maiaEnrichState: sameUser ? prevState.maiaEnrichState : "idle",
    prefilterCache: sameUser ? prevState.prefilterCache || new Map() : new Map(),
    engineByColor: {},
    explorerByColor: {},
  };
}

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